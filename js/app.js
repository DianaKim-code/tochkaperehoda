import { loadGame, saveGame, clearGame, exportGame, readGameFile } from './storage.js';
import { createGame, isValidGame, rollDice, finishCard, reshuffleDeck, changeResource, setPlayerPosition, selectNextPlayer, updateTransitionMap, undo } from './game-engine.js';
import { el, COLORS, renderGame, renderTransitionMap, addParticipantRow, showToast, renderPrintSheet, setupCalibration } from './ui.js';
import { createRoom, getJoinInfo, joinRoom, loadRoom, findRoomAccessByCode, saveRoomState, saveMap, setConnection, leaveRoom, removePlayer, closeRoom, requestParticipantRoll, completeParticipantRoll, loadPendingRollRequests } from './room-service.js';
import { subscribeToRoom, unsubscribeFromRoom } from './realtime-service.js';
import { normalizeRoomCode, readRoomSession, writeRoomSession, clearRoomSession, shouldRestoreRoomSession, sanitizeSharedState, attachPrivateMaps } from './online-storage.js';
import { PAWN_LABELS } from '../data/board-coordinates.js';

let gameState = null;
let selectedMapPlayerId = null;
let rolling = false;
let roomContext = null;
let refreshing = false;
let refreshQueued = false;
let mapSaveTimer;
let pendingRollVersion = null;
let processingRollRequests = false;
let rollRequestPollTimer = null;
let connectionState = 'Подключение…';
let invitationMode = false;

const access = () => roomContext ? { role: roomContext.role, playerId: roomContext.playerId, pendingRollVersion, connectionState } : { role: 'local', playerId: null };
const isHost = () => roomContext?.role === 'host';
const canControlGame = () => !roomContext || isHost();
const escapeMarkup = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));
const colorOptions = colors => colors.map(color => `<option value="${color}">${PAWN_LABELS[color] || color}</option>`).join('');

function renderCurrent() {
  if (!gameState) return;
  renderGame(gameState, selectedMapPlayerId, access());
  el.backup_button.hidden = roomContext?.role === 'participant';
  el.new_game_button.hidden = Boolean(roomContext);
  el.host_tools.hidden = roomContext?.role === 'participant';
}

async function commit(next, toastMessage = null) {
  if (!canControlGame()) return false;
  if (roomContext) next.players?.forEach(player => { player.transitionMap ||= structuredClone(roomContext.maps.get(player.id)); });
  gameState = next;
  if (roomContext) {
    try {
      const result = await saveRoomState(roomContext.roomId, roomContext.version, sanitizeSharedState(gameState), gameState.status === 'complete' ? 'completed' : 'playing');
      roomContext.version = result.state_version;
      roomContext.status = result.room_status;
    } catch (error) {
      showToast(error.message, 5000);
      await refreshOnline();
      return false;
    }
  } else saveGame(gameState);
  renderCurrent();
  if (roomContext) renderWaiting();
  if (toastMessage) showToast(toastMessage);
  return true;
}

async function animateDice(finalValue = null) {
  el.dice.classList.add('is-rolling');
  const animation = setInterval(() => { el.dice.textContent = Math.floor(Math.random() * 6) + 1; }, 80);
  await new Promise(resolve => setTimeout(resolve, 640));
  clearInterval(animation);
  el.dice.classList.remove('is-rolling');
  if (finalValue != null) el.dice.textContent = finalValue;
}

async function processRollRequests() {
  if (!isHost() || processingRollRequests || !roomContext || !gameState) return;
  processingRollRequests = true;
  try {
    const requests = await loadPendingRollRequests(roomContext.roomId);
    for (const request of requests) {
      if (!isHost() || !roomContext || !gameState) break;
      if (request.state_version < roomContext.version) {
        await completeParticipantRoll(request.id);
        continue;
      }
      if (request.state_version > roomContext.version) {
        await refreshOnline();
        break;
      }
      const current = gameState.players[gameState.currentPlayerIndex];
      if (roomContext.status !== 'playing' || gameState.openCard || current?.id !== request.player_id) {
        await refreshOnline();
        break;
      }
      await animateDice(request.roll_value);
      const applied = await commit(rollDice(gameState, request.roll_value));
      if (!applied) break;
      await completeParticipantRoll(request.id);
    }
  } catch (error) {
    showToast(error.message || 'Не удалось обработать бросок участницы.', 5000);
  } finally {
    processingRollRequests = false;
  }
}

function startRollRequestPolling() {
  if (!isHost() || rollRequestPollTimer) return;
  rollRequestPollTimer = window.setInterval(() => {
    if (roomContext?.status === 'playing') processRollRequests();
  }, 2000);
}

function stopRollRequestPolling() {
  if (!rollRequestPollTimer) return;
  window.clearInterval(rollRequestPollTimer);
  rollRequestPollTimer = null;
}

function resetModePicker() {
  invitationMode = false;
  el.mode_actions.hidden = false;
  el.resume_actions.hidden = true;
  el.setup_form.hidden = true;
  el.create_room_form.hidden = true;
  el.join_room_form.hidden = true;
  el.join_room_title.textContent = 'Войти в комнату';
  el.join_room_code_field.hidden = false;
  el.invite_room_code.hidden = true;
  el.join_room_message.textContent = '';
  el.join_room_form.elements.roomCode.readOnly = false;
  el.join_room_form.elements.playerColor.closest('label').hidden = false;
  el.join_room_form.querySelector('[type="submit"]').disabled = false;
}

function configureJoinForm({ invite = false, code = '' } = {}) {
  resetModePicker();
  invitationMode = invite;
  el.mode_actions.hidden = true;
  el.join_room_form.hidden = false;
  el.join_room_title.textContent = invite ? 'Присоединиться к игре' : 'Войти в комнату';
  el.join_room_form.elements.roomCode.value = code;
  el.join_room_form.elements.roomCode.readOnly = invite;
  el.join_room_code_field.hidden = invite;
  el.invite_room_code.hidden = !invite;
  el.invite_room_code.textContent = invite ? `Комната ${code}` : '';
  el.join_room_message.textContent = '';
  el.join_room_form.elements.playerColor.innerHTML = '';
  el.join_room_form.elements.playerColor.closest('label').hidden = invite;
  el.join_room_form.querySelector('[type="submit"]').disabled = invite;
}

async function loadJoinFormInfo(code, invite = false) {
  const form = el.join_room_form;
  form.elements.playerColor.innerHTML = '';
  form.elements.playerColor.closest('label').hidden = true;
  form.querySelector('[type="submit"]').disabled = true;
  el.join_room_message.textContent = 'Проверяем комнату…';
  try {
    const info = await getJoinInfo(code);
    form.elements.roomCode.value = info.normalized_code;
    form.elements.playerColor.innerHTML = colorOptions(info.available_colors);
    form.elements.playerColor.closest('label').hidden = false;
    form.querySelector('[type="submit"]').disabled = !info.available_colors.length;
    el.join_room_message.textContent = info.available_colors.length ? '' : 'В комнате нет свободных фишек.';
    return true;
  } catch (error) {
    el.join_room_message.textContent = error.message;
    if (!invite) showToast(error.message, 5000);
    return false;
  }
}

function showSetup(saved = null) {
  el.start_modal.hidden = false;
  resetModePicker();
  el.resume_actions.hidden = true;
  el.participant_fields.innerHTML = '';
  addParticipantRow(el.participant_fields, 0);
}

function showLocalSetup() {
  el.mode_actions.hidden = true;
  const saved = loadGame();
  el.resume_actions.hidden = !isValidGame(saved);
  el.setup_form.hidden = isValidGame(saved);
}

function gatherParticipants() {
  return [...el.participant_fields.querySelectorAll('.participant-row')].map(row => ({ name: row.querySelector('[name="participantName"]').value, color: row.querySelector('[name="participantColor"]').value }));
}

function roomInvite() {
  const url = new URL(location.href); url.search = ''; url.searchParams.set('room', roomContext.code); return url.toString();
}

function renderRoomChrome() {
  el.room_chip.hidden = !roomContext;
  if (!roomContext) return;
  el.room_code_label.textContent = roomContext.code;
  el.close_room_button.hidden = !isHost();
}

function renderWaiting() {
  if (!roomContext) return;
  const waiting = roomContext.status === 'waiting';
  el.waiting_card.hidden = !waiting;
  if (!waiting) return;
  el.waiting_title.textContent = isHost() ? `Комната ${roomContext.code}` : 'Ждём начала игры';
  el.waiting_helper.textContent = isHost() ? 'Отправьте ссылку участницам и начните, когда все будут готовы.' : `Ведущая: ${roomContext.hostName}. Оставьте эту страницу открытой.`;
  const hostRow = `<div class="waiting-person"><span>${escapeMarkup(roomContext.hostName)}</span><small>Ведущая</small></div>`;
  const playerRows = roomContext.players.map(player => `<div class="waiting-person"><span>${escapeMarkup(player.name)}</span><small>${player.is_connected ? 'в сети' : 'не в сети'}</small>${isHost() ? `<button class="text-button danger-text kick-player" data-player-id="${player.id}" type="button">Удалить</button>` : ''}</div>`).join('');
  el.waiting_players.innerHTML = `<div class="waiting-people">${hostRow}${playerRows || '<p class="helper">Пока никто не присоединился.</p>'}</div>`;
  el.start_online_game_button.hidden = !isHost();
  el.start_online_game_button.disabled = !roomContext.players.length;
  el.roll_button.disabled = true;
  if (!isHost()) {
    document.body.classList.add('participant-view');
    el.roll_button.hidden = false;
    el.roll_button.textContent = 'Игра ещё не началась';
    el.roll_button.setAttribute('aria-label', 'Игра ещё не началась. Ожидайте ведущую.');
    el.turn_helper.textContent = 'Ожидайте, пока ведущая начнёт игру.';
  }
  el.start_modal.hidden = true;
  el.board_status.textContent = 'Комната ожидания';
}

const mapsFromRows = rows => new Map((rows || []).map(row => [row.player_id, row.data]));

async function refreshOnline() {
  if (!roomContext) return false;
  if (refreshing) { refreshQueued = true; return false; }
  refreshing = true;
  try {
    const { room, players, maps } = await loadRoom(roomContext.roomId);
    if (room.status === 'closed' || new Date(room.expires_at) <= new Date()) throw new Error('Комната закрыта или срок её действия истёк.');
    roomContext = { ...roomContext, code: room.code, hostName: room.host_name, status: room.status, version: room.state_version, players, maps: mapsFromRows(maps) };
    if (pendingRollVersion != null && (room.state_version > pendingRollVersion || room.status !== 'playing')) pendingRollVersion = null;
    if (room.game_state && isValidGame(room.game_state)) {
      gameState = attachPrivateMaps(room.game_state, roomContext.maps);
      selectedMapPlayerId = roomContext.role === 'participant' ? roomContext.playerId : (selectedMapPlayerId || gameState.players[0]?.id);
      renderCurrent(); el.start_modal.hidden = true;
    }
    renderRoomChrome(); renderWaiting();
    if (isHost() && room.status === 'playing') queueMicrotask(processRollRequests);
    return true;
  } catch (error) {
    await exitOnline(false); showToast(error.message || 'Доступ к комнате завершён.', 6000);
    return false;
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; refreshOnline(); }
  }
}

async function enterOnline(session) {
  roomContext = { ...session, version: 0, status: 'waiting', players: [], maps: new Map() };
  writeRoomSession(session); renderRoomChrome();
  await subscribeToRoom(session.roomId, {
    onStatus: value => { connectionState = value; el.connection_status.textContent = value; if (gameState) renderCurrent(); },
    onRoom: refreshOnline,
    onPlayers: refreshOnline,
    onMaps: refreshOnline,
    onRollRequest: () => { if (isHost()) processRollRequests(); }
  });
  if (session.role === 'participant') setConnection(session.roomId, true).catch(() => {});
  const restored = await refreshOnline();
  startRollRequestPolling();
  return restored;
}

async function exitOnline(callServer = true) {
  const context = roomContext; roomContext = null;
  stopRollRequestPolling();
  pendingRollVersion = null; connectionState = 'Подключение…';
  await unsubscribeFromRoom();
  if (callServer && context?.role === 'participant') await leaveRoom(context.roomId).catch(() => {});
  clearRoomSession(); gameState = null; selectedMapPlayerId = null;
  document.body.classList.remove('participant-view');
  el.waiting_card.hidden = true; el.room_chip.hidden = true; el.backup_button.hidden = false; el.new_game_button.hidden = false; el.host_tools.hidden = false;
  const saved = loadGame(); showSetup(isValidGame(saved) ? saved : null);
}

el.local_mode_button.addEventListener('click', showLocalSetup);
el.create_room_button.addEventListener('click', () => { resetModePicker(); el.mode_actions.hidden = true; el.create_room_form.hidden = false; });
el.join_room_button.addEventListener('click', async () => {
  const previousCode = el.join_room_form.elements.roomCode.value;
  configureJoinForm({ code: previousCode });
  const code = el.join_room_form.elements.roomCode.value;
  if (code) await loadJoinFormInfo(code);
});
document.querySelectorAll('.setup-back').forEach(button => button.addEventListener('click', event => {
  if (invitationMode && event.currentTarget.closest('#join-room-form')) {
    const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
  }
  resetModePicker();
}));

el.create_room_form.addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const result = await createRoom(event.currentTarget.elements.hostName.value); await enterOnline({ roomId: result.room_id, code: result.room_code, role: 'host', playerId: null }); showToast(`Комната ${result.room_code} создана.`); }
  catch (error) { showToast(error.message, 5000); } finally { button.disabled = false; }
});

el.join_room_form.elements.roomCode.addEventListener('change', async event => {
  if (!event.target.readOnly) await loadJoinFormInfo(event.target.value);
});
el.join_room_form.addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = event.submitter; button.disabled = true;
  try { const result = await joinRoom(form.elements.roomCode.value, form.elements.playerName.value, form.elements.playerColor.value); await enterOnline({ roomId: result.room_id, code: result.normalized_code, role: 'participant', playerId: result.player_id }); showToast(`Вы вошли в комнату ${result.normalized_code}.`); }
  catch (error) { showToast(error.message, 5000); } finally { button.disabled = false; }
});

el.setup_form.addEventListener('submit', event => {
  event.preventDefault(); const participants = gatherParticipants(); const colors = participants.map(item => item.color);
  if (new Set(colors).size !== colors.length) return showToast('Выберите для каждой участницы свободную фишку.');
  gameState = createGame(participants); selectedMapPlayerId = gameState.players[0].id; saveGame(gameState); renderCurrent(); el.start_modal.hidden = true; showToast('Партия создана. Можно бросать кубик.');
});
el.add_participant.addEventListener('click', () => addParticipantRow(el.participant_fields, el.participant_fields.children.length, COLORS[el.participant_fields.children.length]));
el.participant_fields.addEventListener('click', event => { if (!event.target.closest('.remove-participant')) return; if (el.participant_fields.children.length === 1) return showToast('В партии должна быть хотя бы одна участница.'); event.target.closest('.participant-row').remove(); });
el.resume_button.addEventListener('click', () => { const saved = loadGame(); if (!isValidGame(saved)) return showToast('Сохранённая партия повреждена. Создайте новую.'); gameState = saved; selectedMapPlayerId = gameState.players[gameState.currentPlayerIndex]?.id; renderCurrent(); el.start_modal.hidden = true; });
el.fresh_button.addEventListener('click', () => { el.resume_actions.hidden = true; el.setup_form.hidden = false; });

el.start_online_game_button.addEventListener('click', async () => {
  if (!isHost() || !roomContext.players.length) return;
  gameState = attachPrivateMaps(createGame(roomContext.players.map(player => ({ id: player.id, name: player.name, color: player.color }))), roomContext.maps);
  selectedMapPlayerId = gameState.players[0].id; await commit(gameState, 'Онлайн-игра началась.');
});
el.waiting_players.addEventListener('click', async event => { const button = event.target.closest('.kick-player'); if (!button || !isHost()) return; try { await removePlayer(roomContext.roomId, button.dataset.playerId); await refreshOnline(); } catch (error) { showToast(error.message); } });
el.copy_code_button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomContext.code); showToast('Код комнаты скопирован.'); } catch { showToast(roomContext.code, 5000); } });
el.copy_invite_button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(roomInvite()); showToast('Ссылка на комнату скопирована.'); } catch { showToast(roomInvite(), 7000); } });
el.exit_room_button.addEventListener('click', () => exitOnline(true));
el.close_room_button.addEventListener('click', async () => { if (!isHost() || !confirm('Закрыть комнату для всех участниц?')) return; try { await closeRoom(roomContext.roomId); await exitOnline(false); showToast('Комната закрыта.'); } catch (error) { showToast(error.message); } });

el.roll_button.addEventListener('click', async () => {
  if (!gameState || rolling || gameState.openCard) return;
  if (roomContext?.role === 'host') return;
  if (roomContext?.role === 'participant') {
    const current = gameState.players[gameState.currentPlayerIndex];
    if (pendingRollVersion != null || roomContext.status !== 'playing' || current?.id !== roomContext.playerId || connectionState !== 'Подключено') return;
    rolling = true;
    el.roll_button.disabled = true;
    try {
      const request = await requestParticipantRoll(roomContext.roomId, roomContext.version);
      pendingRollVersion = request.state_version;
      renderCurrent();
    } catch (error) {
      pendingRollVersion = null;
      showToast(error.message || 'Не удалось отправить бросок. Проверьте соединение.', 5000);
      await refreshOnline();
    } finally {
      rolling = false;
    }
    return;
  }
  rolling = true;
  el.roll_button.disabled = true;
  await animateDice();
  rolling = false;
  await commit(rollDice(gameState));
});
el.confirm_card_button.addEventListener('click', () => commit(finishCard(gameState, false)));
el.skip_card_button.addEventListener('click', () => commit(finishCard(gameState, true), 'Карточка пропущена и записана в журнал.'));
el.reshuffle_button.addEventListener('click', () => commit(reshuffleDeck(gameState, gameState.openCard.deck), 'Колода перемешана.'));
el.undo_button.addEventListener('click', () => commit(undo(gameState), 'Последнее игровое действие отменено.'));
el.next_player_button.addEventListener('click', () => commit(selectNextPlayer(gameState)));
el.players_list.addEventListener('click', event => { const button = event.target.closest('[data-resource]'); if (!button || !gameState || !canControlGame()) return; commit(changeResource(gameState, button.dataset.player, button.dataset.resource, Number(button.dataset.delta))); });
el.position_player.addEventListener('change', () => { const player = gameState.players.find(item => item.id === el.position_player.value); el.position_value.value = player?.position ?? 0; });
el.set_position_button.addEventListener('click', () => commit(setPlayerPosition(gameState, el.position_player.value, el.position_value.value), 'Позиция исправлена.'));
el.map_player.addEventListener('change', () => { selectedMapPlayerId = el.map_player.value; renderTransitionMap(gameState.players.find(player => player.id === selectedMapPlayerId), true); });
el.transition_map.addEventListener('input', event => {
  const field = event.target.dataset.mapField; if (!field || !gameState) return;
  const playerId = roomContext?.role === 'participant' ? roomContext.playerId : (selectedMapPlayerId || el.map_player.value);
  gameState = updateTransitionMap(gameState, playerId, field, event.target.value, event.target.dataset.integrationIndex === undefined ? null : Number(event.target.dataset.integrationIndex));
  if (!roomContext) return saveGame(gameState);
  clearTimeout(mapSaveTimer); mapSaveTimer = setTimeout(async () => { const player = gameState.players.find(item => item.id === playerId); try { await saveMap(roomContext.roomId, playerId, player.transitionMap); } catch (error) { showToast(error.message, 5000); } }, 500);
});

el.print_map_button.addEventListener('click', () => { const player = gameState?.players.find(item => item.id === (roomContext?.role === 'participant' ? roomContext.playerId : (selectedMapPlayerId || el.map_player.value))); if (!player) return; renderPrintSheet(player); document.body.classList.add('printing-map'); const cleanup = () => document.body.classList.remove('printing-map'); window.addEventListener('afterprint', cleanup, {once:true}); window.print(); setTimeout(cleanup, 1500); });
el.export_button.addEventListener('click', () => gameState && exportGame(gameState));
el.backup_button.addEventListener('click', () => gameState ? exportGame(gameState) : showToast('Сначала создайте партию.'));
el.import_input.addEventListener('change', async event => { const file = event.target.files[0]; if (!file || roomContext) return; try { const imported = await readGameFile(file); if (!isValidGame(imported)) throw new Error('В файле нет корректного состояния партии.'); imported.history ||= []; imported.log ||= []; gameState = imported; selectedMapPlayerId = imported.players[imported.currentPlayerIndex]?.id; await commit(gameState, 'Резервная копия восстановлена.'); el.start_modal.hidden = true; } catch (error) { showToast(error.message); } event.target.value = ''; });
el.new_game_button.addEventListener('click', () => { if (!gameState) showSetup(); else el.confirm_modal.hidden = false; });
el.cancel_reset.addEventListener('click', () => { el.confirm_modal.hidden = true; });
el.confirm_reset.addEventListener('click', () => { clearGame(); gameState = null; selectedMapPlayerId = null; el.confirm_modal.hidden = true; showSetup(); });
el.card_image.addEventListener('error', () => showToast('Не удалось загрузить изображение карточки. Проверьте комплект материалов.', 6000));
window.addEventListener('keydown', event => { if (event.key === 'Escape' && !el.confirm_modal.hidden) el.confirm_modal.hidden = true; });
window.addEventListener('beforeunload', () => { if (roomContext?.role === 'participant') setConnection(roomContext.roomId, false).catch(() => {}); });

async function boot() {
  const queryCode = normalizeRoomCode(new URLSearchParams(location.search).get('room') || ''); const session = readRoomSession(); const saved = loadGame();
  showSetup(isValidGame(saved) ? saved : null);
  let restored = false;
  if (shouldRestoreRoomSession(queryCode, session)) restored = await enterOnline(session);
  if (!restored && queryCode) {
    try {
      const existingAccess = await findRoomAccessByCode(queryCode);
      if (existingAccess) await enterOnline(existingAccess);
      else {
        configureJoinForm({ invite: true, code: queryCode });
        await loadJoinFormInfo(queryCode, true);
      }
    } catch (error) {
      configureJoinForm({ invite: true, code: queryCode });
      el.join_room_message.textContent = error.message;
    }
  }
  setupCalibration();
}

boot();
