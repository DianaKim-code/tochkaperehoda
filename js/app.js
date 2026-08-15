import { loadGame, saveGame, clearGame, exportGame, readGameFile } from './storage.js';
import { createGame, isValidGame, rollDice, finishCard, reshuffleDeck, changeResource, setPlayerPosition, selectNextPlayer, updateTransitionMap, undo } from './game-engine.js';
import { el, COLORS, renderGame, renderTransitionMap, addParticipantRow, showToast, renderPrintSheet, setupCalibration } from './ui.js';

let gameState = null;
let selectedMapPlayerId = null;
let rolling = false;

function commit(next, toastMessage = null) {
  gameState = next;
  saveGame(gameState);
  renderGame(gameState, selectedMapPlayerId);
  if (toastMessage) showToast(toastMessage);
}

function showSetup(saved = null) {
  el.start_modal.hidden = false;
  el.resume_actions.hidden = !saved;
  el.setup_form.hidden = Boolean(saved);
  el.participant_fields.innerHTML = '';
  addParticipantRow(el.participant_fields, 0);
}

function gatherParticipants() {
  const rows = [...el.participant_fields.querySelectorAll('.participant-row')];
  return rows.map(row => ({ name: row.querySelector('[name="participantName"]').value, color: row.querySelector('[name="participantColor"]').value }));
}

el.setup_form.addEventListener('submit', event => {
  event.preventDefault();
  const participants = gatherParticipants();
  const colors = participants.map(item => item.color);
  if (new Set(colors).size !== colors.length) { showToast('Выберите для каждой участницы свободную фишку.'); return; }
  gameState = createGame(participants);
  selectedMapPlayerId = gameState.players[0].id;
  saveGame(gameState);
  renderGame(gameState, selectedMapPlayerId);
  el.start_modal.hidden = true;
  showToast('Партия создана. Можно бросать кубик.');
});

el.add_participant.addEventListener('click', () => {
  const index = el.participant_fields.children.length;
  addParticipantRow(el.participant_fields, index, COLORS[index]);
});

el.participant_fields.addEventListener('click', event => {
  if (!event.target.closest('.remove-participant')) return;
  if (el.participant_fields.children.length === 1) { showToast('В партии должна быть хотя бы одна участница.'); return; }
  event.target.closest('.participant-row').remove();
});

el.resume_button.addEventListener('click', () => {
  const saved = loadGame();
  if (!isValidGame(saved)) { showToast('Сохранённая партия повреждена. Создайте новую.'); el.resume_actions.hidden = true; el.setup_form.hidden = false; return; }
  gameState = saved; selectedMapPlayerId = gameState.players[gameState.currentPlayerIndex]?.id;
  renderGame(gameState, selectedMapPlayerId); el.start_modal.hidden = true;
});

el.fresh_button.addEventListener('click', () => { el.resume_actions.hidden = true; el.setup_form.hidden = false; });

el.roll_button.addEventListener('click', async () => {
  if (!gameState || rolling || gameState.openCard) return;
  rolling = true; el.roll_button.disabled = true; el.dice.classList.add('is-rolling');
  const animation = setInterval(() => { el.dice.textContent = Math.floor(Math.random() * 6) + 1; }, 80);
  await new Promise(resolve => setTimeout(resolve, 640));
  clearInterval(animation); el.dice.classList.remove('is-rolling'); rolling = false;
  commit(rollDice(gameState));
});

el.confirm_card_button.addEventListener('click', () => commit(finishCard(gameState, false)));
el.skip_card_button.addEventListener('click', () => commit(finishCard(gameState, true), 'Карточка пропущена и записана в журнал.'));
el.reshuffle_button.addEventListener('click', () => commit(reshuffleDeck(gameState, gameState.openCard.deck), 'Колода перемешана.'));
el.undo_button.addEventListener('click', () => commit(undo(gameState), 'Последнее игровое действие отменено.'));
el.next_player_button.addEventListener('click', () => commit(selectNextPlayer(gameState)));

el.players_list.addEventListener('click', event => {
  const button = event.target.closest('[data-resource]'); if (!button || !gameState) return;
  commit(changeResource(gameState, button.dataset.player, button.dataset.resource, Number(button.dataset.delta)));
});

el.position_player.addEventListener('change', () => {
  const player = gameState.players.find(item => item.id === el.position_player.value); el.position_value.value = player?.position ?? 0;
});
el.set_position_button.addEventListener('click', () => commit(setPlayerPosition(gameState, el.position_player.value, el.position_value.value), 'Позиция исправлена.'));

el.map_player.addEventListener('change', () => {
  selectedMapPlayerId = el.map_player.value;
  renderTransitionMap(gameState.players.find(player => player.id === selectedMapPlayerId));
});
el.transition_map.addEventListener('input', event => {
  const field = event.target.dataset.mapField; if (!field || !gameState) return;
  gameState = updateTransitionMap(gameState, selectedMapPlayerId || el.map_player.value, field, event.target.value, event.target.dataset.integrationIndex === undefined ? null : Number(event.target.dataset.integrationIndex));
  saveGame(gameState);
});

el.print_map_button.addEventListener('click', () => {
  const player = gameState?.players.find(item => item.id === (selectedMapPlayerId || el.map_player.value));
  if (!player) return;
  renderPrintSheet(player); document.body.classList.add('printing-map');
  const cleanup = () => document.body.classList.remove('printing-map');
  window.addEventListener('afterprint', cleanup, {once:true}); window.print(); setTimeout(cleanup, 1500);
});

el.export_button.addEventListener('click', () => gameState && exportGame(gameState));
el.backup_button.addEventListener('click', () => { if (gameState) exportGame(gameState); else showToast('Сначала создайте партию.'); });
el.import_input.addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const imported = await readGameFile(file);
    if (!isValidGame(imported)) throw new Error('В файле нет корректного состояния партии.');
    imported.history ||= []; imported.log ||= []; gameState = imported; selectedMapPlayerId = imported.players[imported.currentPlayerIndex]?.id;
    commit(gameState, 'Резервная копия восстановлена.'); el.start_modal.hidden = true;
  } catch (error) { showToast(error.message); }
  event.target.value = '';
});

el.new_game_button.addEventListener('click', () => { if (!gameState) showSetup(); else el.confirm_modal.hidden = false; });
el.cancel_reset.addEventListener('click', () => { el.confirm_modal.hidden = true; });
el.confirm_reset.addEventListener('click', () => {
  clearGame(); gameState = null; selectedMapPlayerId = null; el.confirm_modal.hidden = true; showSetup();
});

el.card_image.addEventListener('error', () => showToast('Не удалось загрузить изображение карточки. Проверьте комплект материалов.', 6000));
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !el.confirm_modal.hidden) el.confirm_modal.hidden = true;
});

const saved = loadGame();
showSetup(isValidGame(saved) ? saved : null);
if (!saved) { el.resume_actions.hidden = true; el.setup_form.hidden = false; }
setupCalibration();
