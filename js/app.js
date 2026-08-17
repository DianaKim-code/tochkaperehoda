import { loadGame, saveGame, clearGame, exportGame, readGameFile } from './storage.js';
import { createGame, isValidGame, rollDice, finishCard, reshuffleDeck, changeResource, setPlayerPosition, selectNextPlayer, updateTransitionMap, undo } from './game-engine.js';
import { el, COLORS, renderGame, renderTransitionMap, addParticipantRow, showToast, renderPrintSheet, setupCalibration } from './ui.js';
import { createRoom, getJoinInfo, joinRoom, loadRoom, saveRoomState, saveMap, setConnection, leaveRoom, removePlayer, closeRoom } from './room-service.js';
import { subscribeToRoom, unsubscribeFromRoom } from './realtime-service.js';
import { normalizeRoomCode, readRoomSession, writeRoomSession, clearRoomSession, sanitizeSharedState, attachPrivateMaps } from './online-storage.js';
import { PAWN_LABELS } from '../data/board-coordinates.js';

let gameState = null;
let selectedMapPlayerId = null;
let rolling = false;
let roomContext = null;
let refreshing = false;
let refreshQueued = false;
let mapSaveTimer;

const access = () => roomContext ? { role: roomContext.role, playerId: roomContext.playerId } : { role: 'local', playerId: null };
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
  if (!canControlGame()) return;
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
      return;
    }
  } else saveGame(gameState);
  renderCurrent();
  if (roomContext) renderWaiting();
  if (toastMessage) showToast(toastMessage);
}

function resetModePicker() {
  el.mode_actions.hidden = false;
  el.resume_actions.hidden = true;
  el.setup_form.hidden = true;
  el.create_room_form.hidden = true;
  el.join_room_form.hidden = true;
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
  el.start_modal.hidden = true;
  el.board_status.textContent = 'Комната ожидания';
}

const mapsFromRows = rows => new Map((rows || []).map(row => [row.player_id, row.data]));

async function refreshOnline() {
  if (!roomContext) return;
  if (refreshing) { refreshQueued = true; return; }
  refreshing = true;
  try {
    const { room, players, maps } = await loadRoom(roomContext.roomId);
    if (room.status === 'closed' || new Date(room.expires_at) <= new Date()) throw new Error('Комната закрыта или срок её действия истёк.');
    roomContext = { ...roomContext, code: room.code, hostName: room.host_name, status: room.status, version: room.state_version, players, maps: mapsFromRows(maps) };
    if (room.game_state && isValidGame(room.game_state)) {
      gameState = attachPrivateMaps(room.game_state, roomContext.maps);
      selectedMapPlayerId = roomContext.role === 'participant' ? roomContext.playerId : (selectedMapPlayerId || gameState.players[0]?.id);
      renderCurrent(); el.start_modal.hidden = true;
    }
    renderRoomChrome(); renderWaiting();
  } catch (error) {
    await exitOnline(false); showToast(error.message || 'Доступ к комнате завершён.', 6000);
  } finally {
    refreshing = false;
    if (refreshQueued) { refreshQueued = false; refreshOnline(); }
  }
}

async function enterOnline(session) {
  roomContext = { ...session, version: 0, status: 'waiting', players: [], maps: new Map() };
  writeRoomSession(session); renderRoomChrome();
  await subscribeToRoom(session.roomId, { onStatus: value => { el.connection_status.textContent = value; }, onRoom: refreshOnline, onPlayers: refreshOnline, onMaps: refreshOnline });
  if (session.role === 'participant') setConnection(session.roomId, true).catch(() => {});
  await refreshOnline();
}

async function exitOnline(callServer = true) {
  const context = roomContext; roomContext = null;
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
  resetModePicker(); el.mode_actions.hidden = true; el.join_room_form.hidden = false;
  const code = el.join_room_form.elements.roomCode.value;
  if (code) try { const info = await getJoinInfo(code); el.join_room_form.elements.playerColor.innerHTML = colorOptions(info.available_colors); } catch (error) { showToast(error.message); }
});
document.querySelectorAll('.setup-back').forEach(button => button.addEventListener('click', resetModePicker));

el.create_room_form.addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try { const result = await createRoom(event.currentTarget.elements.hostName.value); await enterOnline({ roomId: result.room_id, code: result.room_code, role: 'host', playerId: null }); showToast(`Комната ${result.room_code} создана.`); }
  catch (error) { showToast(error.message, 5000); } finally { button.disabled = false; }
});

el.join_room_form.elements.roomCode.addEventListener('change', async event => {
  try { const info = await getJoinInfo(event.target.value); event.target.value = info.normalized_code; el.join_room_form.elements.playerColor.innerHTML = colorOptions(info.available_colors); }
  catch (error) { showToast(error.message); }
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
  if (!gameState || rolling || gameState.openCard || !canControlGame()) return;
  rolling = true; el.roll_button.disabled = true; el.dice.classList.add('is-rolling'); const animation = setInterval(() => { el.dice.textContent = Math.floor(Math.random() * 6) + 1; }, 80);
  await new Promise(resolve => setTimeout(resolve, 640)); clearInterval(animation); el.dice.classList.remove('is-rolling'); rolling = false; await commit(rollDice(gameState));
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
  if (queryCode) {
    resetModePicker(); el.mode_actions.hidden = true; el.join_room_form.hidden = false; el.join_room_form.elements.roomCode.value = queryCode;
    try { const info = await getJoinInfo(queryCode); el.join_room_form.elements.playerColor.innerHTML = colorOptions(info.available_colors); } catch (error) { showToast(error.message, 5000); }
  } else if (session?.roomId && session?.role) await enterOnline(session);
  setupCalibration();
}

boot();
