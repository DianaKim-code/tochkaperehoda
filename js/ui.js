import { BOARD_COORDINATES, PAWN_IMAGES, PAWN_LABELS } from '../data/board-coordinates.js';
import { DECKS } from '../data/decks.js';
import { currentPlayer, resourceBalance } from './game-engine.js';
import { participantRollUiState } from './online-storage.js';
import { zoneForCell } from '../data/board-map.js';

export const COLORS = ['emerald', 'blue', 'purple', 'red', 'coral', 'turquoise'];

const $ = id => document.getElementById(id);
export const el = new Proxy({}, { get: (_, key) => $(key.replaceAll('_', '-')) });

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[char]));

function fanOffsets(count) {
  if (count === 1) return [[0,0]];
  const radius = count > 4 ? 16 : 12;
  return Array.from({length: count}, (_, i) => {
    const angle = (-100 + (200 / Math.max(1, count - 1)) * i) * Math.PI / 180;
    return [Math.cos(angle) * radius, Math.sin(angle) * radius];
  });
}

function renderPawns(state) {
  const groups = Object.groupBy ? Object.groupBy(state.players, player => player.position) : state.players.reduce((acc, player) => ((acc[player.position] ||= []).push(player), acc), {});
  el.pawns_layer.innerHTML = Object.entries(groups).flatMap(([position, players]) => {
    const coord = BOARD_COORDINATES[Number(position)] || BOARD_COORDINATES[0];
    const offsets = fanOffsets(players.length);
    return players.map((player, index) => `<img class="pawn" src="${PAWN_IMAGES[player.color]}" alt="${escapeHtml(player.name)}, ячейка ${position}" title="${escapeHtml(player.name)} — ячейка ${position}" style="left:${coord.x}%;top:${coord.y}%;--fan-x:${offsets[index][0]}px;--fan-y:${offsets[index][1]}px">`);
  }).join('');
}

function resourceMarkup(player, kind, image, label) {
  const resource = player.resources[kind];
  return `<div class="resource">
    <img src="${image}" alt="${label}">
    <div><span class="resource-count">${resourceBalance(resource)}</span><small>получено ${resource.received} · применено ${resource.used}</small></div>
    <div class="stepper"><button type="button" data-resource="${kind}" data-delta="-1" data-player="${player.id}" aria-label="Применить ${label.toLowerCase()}">−</button><button type="button" data-resource="${kind}" data-delta="1" data-player="${player.id}" aria-label="Добавить ${label.toLowerCase()}">+</button></div>
  </div>`;
}

function renderPlayers(state) {
  el.players_count.textContent = `${state.players.length} / 6`;
  el.players_list.innerHTML = state.players.map((player, index) => `<article class="player-card ${index === state.currentPlayerIndex ? 'is-current' : ''}">
    <div class="player-main"><img src="${PAWN_IMAGES[player.color]}" alt=""><div><div class="player-name">${escapeHtml(player.name)}</div><div class="player-position">${player.position === 0 ? 'Старт' : `Ячейка ${player.position}`} · ${zoneForCell(Math.max(1, player.position))}</div></div>${player.finished ? '<span class="finished-badge">Путь завершён</span>' : ''}</div>
    <div class="resource-grid">${resourceMarkup(player, 'tokens', './assets/resources/token.png', 'Жетон')}${resourceMarkup(player, 'crystals', './assets/resources/crystal.png', 'Кристалл')}</div>
  </article>`).join('');
}

function playerOptions(state, selected) {
  return state.players.map(player => `<option value="${player.id}" ${player.id === selected ? 'selected' : ''}>${escapeHtml(player.name)}</option>`).join('');
}

export function renderTransitionMap(player, editable = true) {
  if (!player) { el.transition_map.innerHTML = '<p class="helper">Нет участниц.</p>'; return; }
  const map = player.transitionMap || { request:'', tensionStart:'', tensionEnd:'', integrations:['','','','',''], decision:'', firstStep:'', deadline:'', support:'', takeaway:'' };
  el.transition_map.innerHTML = `
    <label>Исходный запрос<textarea data-map-field="request" placeholder="С чем участница входит в игру">${escapeHtml(map.request)}</textarea></label>
    <div class="map-grid-two"><label>Начальная оценка 0–10<input data-map-field="tensionStart" type="number" min="0" max="10" value="${escapeHtml(map.tensionStart)}"></label><label>Итоговая оценка 0–10<input data-map-field="tensionEnd" type="number" min="0" max="10" value="${escapeHtml(map.tensionEnd)}"></label></div>
    <div class="integration-fields"><h3>Интеграционные выводы</h3>${map.integrations.map((value, i) => `<label>${i + 1}. ${['Где я сейчас','Что я завершаю','Что меня удерживает','На что я могу опереться','Мой следующий шаг'][i]}<textarea data-map-field="integrations" data-integration-index="${i}">${escapeHtml(value)}</textarea></label>`).join('')}</div>
    <label>Главное решение<textarea data-map-field="decision">${escapeHtml(map.decision)}</textarea></label>
    <label>Первый безопасный шаг<textarea data-map-field="firstStep">${escapeHtml(map.firstStep)}</textarea></label>
    <div class="map-grid-two"><label>Срок<input data-map-field="deadline" value="${escapeHtml(map.deadline)}"></label><label>Необходимая поддержка<input data-map-field="support" value="${escapeHtml(map.support)}"></label></div>
    <label>С чем участница уходит<textarea data-map-field="takeaway">${escapeHtml(map.takeaway)}</textarea></label>`;
  el.transition_map.querySelectorAll('input,textarea').forEach(input => { input.disabled = !editable; });
}

function renderCard(state) {
  const card = state.openCard;
  el.card_modal.hidden = !card;
  if (!card) return;
  el.card_kicker.textContent = card.integration ? 'Интеграция' : 'Открытая карточка';
  el.card_title.textContent = DECKS[card.deck]?.title || 'Карточка';
  el.card_cell.textContent = `Ячейка ${card.cell}`;
  el.deck_exhausted.hidden = !card.exhausted;
  el.card_image.parentElement.hidden = card.exhausted;
  el.reshuffle_button.hidden = !card.exhausted;
  el.confirm_card_button.hidden = card.exhausted;
  if (!card.exhausted) { el.card_image.src = card.image; el.card_image.alt = `${DECKS[card.deck].title}, карточка ${card.number}`; }
}

export function renderGame(state, selectedMapPlayerId = null, access = { role: 'local', playerId: null }) {
  if (!state) return;
  const current = currentPlayer(state);
  el.turn_number.textContent = state.turnNumber;
  el.board_status.textContent = state.status === 'complete' ? 'Все участницы завершили путь' : current ? `${current.name} · ${current.position ? `ячейка ${current.position}` : 'старт'}` : '—';
  el.current_person.innerHTML = current ? `<img src="${PAWN_IMAGES[current.color]}" alt="" style="width:34px;height:34px;object-fit:contain;vertical-align:middle;margin-right:8px">${escapeHtml(current.name)}` : '—';
  el.dice.textContent = state.dice || '•';
  el.turn_helper.textContent = state.openCard ? 'Сначала подтвердите или пропустите открытую карточку.' : current?.finished ? 'Путь участницы завершён.' : 'Кубик переместит фишку и откроет карточку.';
  el.roll_button.textContent = 'Бросить кубик';
  el.roll_button.setAttribute('aria-label', 'Бросить кубик');
  el.roll_button.disabled = Boolean(state.openCard || !current || current.finished || state.status !== 'playing');
  el.next_player_button.disabled = state.players.length < 2 || state.status !== 'playing';
  el.undo_button.disabled = !state.history?.length;
  renderPawns(state);
  renderPlayers(state);
  const mapId = state.players.some(player => player.id === selectedMapPlayerId) ? selectedMapPlayerId : current?.id || state.players[0]?.id;
  const participant = access.role === 'participant';
  const allowedMapId = participant ? access.playerId : mapId;
  el.map_player.innerHTML = playerOptions(state, allowedMapId);
  el.position_player.innerHTML = playerOptions(state, current?.id);
  el.position_value.value = current?.position ?? 0;
  renderTransitionMap(state.players.find(player => player.id === allowedMapId), !participant || allowedMapId === access.playerId);
  el.game_log.innerHTML = state.log.length ? state.log.map(item => `<li><time>${new Date(item.at).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})}</time> — ${escapeHtml(item.message)}</li>`).join('') : '<li>Действия появятся здесь.</li>';
  renderCard(state);
  document.body.classList.toggle('participant-view', participant);
  if (participant) {
    const rollState = participantRollUiState(state, access.playerId, access.pendingRollVersion, access.connectionState);
    el.roll_button.hidden = false;
    el.roll_button.disabled = rollState.disabled;
    el.roll_button.textContent = rollState.label;
    el.roll_button.setAttribute('aria-label', `${rollState.label}. ${rollState.reason}`);
    el.turn_helper.textContent = rollState.reason;
    [el.next_player_button, el.undo_button, el.confirm_card_button, el.skip_card_button, el.reshuffle_button].forEach(button => { if (button) button.hidden = true; });
  } else if (access.role === 'host') {
    el.roll_button.hidden = false;
    el.roll_button.disabled = true;
    el.roll_button.textContent = current ? `Ожидаем бросок: ${current.name}` : 'Ожидаем участницу';
    el.roll_button.setAttribute('aria-label', el.roll_button.textContent);
    el.turn_helper.textContent = state.openCard ? 'Завершите открытую карточку, чтобы продолжить.' : 'Текущая участница бросает кубик со своего устройства.';
    el.next_player_button.hidden = false; el.undo_button.hidden = false; el.skip_card_button.hidden = false;
  } else {
    el.roll_button.hidden = false; el.next_player_button.hidden = false; el.undo_button.hidden = false; el.skip_card_button.hidden = false;
  }
}

export function showToast(message, duration = 3200) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { el.toast.hidden = true; }, duration);
}

export function addParticipantRow(container, index, preferredColor = COLORS[index]) {
  if (container.children.length >= 6) return;
  const row = document.createElement('div');
  row.className = 'participant-row';
  row.innerHTML = `<label>Имя<input name="participantName" required maxlength="48" placeholder="Имя участницы ${index + 1}"></label><label>Фишка<select name="participantColor">${COLORS.map(color => `<option value="${color}" ${color === preferredColor ? 'selected' : ''}>${PAWN_LABELS[color]}</option>`).join('')}</select></label><button class="remove-participant" type="button" aria-label="Удалить участницу">×</button>`;
  container.append(row);
}

export function renderPrintSheet(player) {
  const m = player.transitionMap;
  const fields = [
    ['Исходный запрос',m.request,true],['Начальная оценка',m.tensionStart],
    ...m.integrations.map((v,i)=>[`Интеграция ${i+1}`,v,true]),
    ['Главное решение',m.decision,true],['Первый безопасный шаг',m.firstStep,true],['Срок',m.deadline],['Необходимая поддержка',m.support],['Итоговая оценка',m.tensionEnd],['С чем участница уходит',m.takeaway,true]
  ];
  el.print_sheet.innerHTML = `<header class="print-map-header"><h1>Карта перехода</h1><p>${escapeHtml(player.name)} · игра «Точка перехода»</p></header><div class="print-map-grid">${fields.map(([label,value,wide])=>`<div class="print-map-field ${wide?'wide':''}"><strong>${label}</strong><p>${escapeHtml(value || '—')}</p></div>`).join('')}</div>`;
}

export function setupCalibration() {
  if (!new URLSearchParams(location.search).has('calibrate')) return;
  const layer = el.calibration_layer;
  layer.hidden = false;
  const points = [];
  showToast('Калибровка: кликните центры ячеек 0–75 по порядку.', 7000);
  layer.addEventListener('click', event => {
    const rect = layer.getBoundingClientRect();
    const point = { x: +(((event.clientX - rect.left) / rect.width) * 100).toFixed(2), y: +(((event.clientY - rect.top) / rect.height) * 100).toFixed(2) };
    points.push(point);
    const dot = document.createElement('span'); dot.className = 'calibration-dot'; dot.style.left = `${point.x}%`; dot.style.top = `${point.y}%`; dot.title = String(points.length - 1); layer.append(dot);
    showToast(`Калибровка: ${points.length}/76`, 900);
    if (points.length === 76) {
      const blob = new Blob([`export const BOARD_COORDINATES = ${JSON.stringify(points, null, 2)};\n`], {type:'text/javascript'});
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'board-coordinates.js'; link.click(); URL.revokeObjectURL(link.href);
    }
  });
}
