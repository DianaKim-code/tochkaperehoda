import { CELL_DECK, INTEGRATIONS, INTEGRATION_JUMPS } from '../data/board-map.js';
import { MAIN_DECK_KEYS, INTEGRATION_NUMBER, cardImage } from '../data/decks.js';

const EMPTY_MAP = () => ({
  request: '', tensionStart: '', integrations: ['', '', '', '', ''], decision: '', firstStep: '', deadline: '',
  support: '', tensionEnd: '', takeaway: ''
});

const EMPTY_RESOURCES = () => ({
  tokens: { received: 0, used: 0 }, crystals: { received: 0, used: 0 }
});

function uid() { return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function clone(value) { return structuredClone(value); }
function stamp() { return new Date().toISOString(); }

function addLog(state, type, message, playerId = null) {
  state.log.unshift({ id: uid(), at: stamp(), type, message, playerId });
  state.log = state.log.slice(0, 150);
}

function checkpoint(state) {
  const next = clone(state);
  const snapshot = clone(state);
  snapshot.history = [];
  next.history = [...(state.history || []), snapshot].slice(-30);
  return next;
}

function blankUsedCards() {
  return Object.fromEntries(MAIN_DECK_KEYS.map(key => [key, []]));
}

export function createGame(participants) {
  const now = stamp();
  return {
    version: 1, id: uid(), createdAt: now, updatedAt: now, status: 'playing', turnNumber: 1, currentPlayerIndex: 0,
    dice: null, rolling: false, openCard: null, usedCards: blankUsedCards(), history: [], log: [],
    players: participants.map((person, index) => ({
      id: uid(), name: person.name.trim() || `Участница ${index + 1}`, color: person.color, position: 0,
      finished: false, resources: EMPTY_RESOURCES(), transitionMap: EMPTY_MAP()
    }))
  };
}

export function isValidGame(value) {
  return Boolean(value && value.version === 1 && Array.isArray(value.players) && value.players.length >= 1 && value.players.length <= 6);
}

function chooseCard(state, deck, cell, playerId) {
  const used = state.usedCards[deck] || [];
  const available = Array.from({ length: 24 }, (_, i) => i + 1).filter(number => !used.includes(number));
  if (!available.length) {
    return { deck, cell, playerId, exhausted: true, image: null, number: null, integration: false };
  }
  const number = available[Math.floor(Math.random() * available.length)];
  state.usedCards[deck] = [...used, number];
  return { deck, cell, playerId, exhausted: false, number, image: cardImage(deck, number), integration: false };
}

function openCardForCell(state, cell, playerId) {
  const deck = CELL_DECK[cell];
  if (deck === 'integration') {
    const number = INTEGRATION_NUMBER[cell];
    state.openCard = { deck, cell, playerId, exhausted: false, number, image: cardImage('integration', number), integration: true };
  } else {
    state.openCard = chooseCard(state, deck, cell, playerId);
  }
}

export function rollDice(state, forcedValue = null) {
  if (state.openCard || state.rolling || state.status !== 'playing') return state;
  let next = checkpoint(state);
  const player = next.players[next.currentPlayerIndex];
  if (!player || player.finished) return next;
  const value = forcedValue ?? (Math.floor(Math.random() * 6) + 1);
  const target = Math.min(75, player.position + value);
  player.position = target;
  next.dice = value;
  addLog(next, 'ROLL_DICE', `${player.name}: выпало ${value}, переход на ячейку ${target}`, player.id);
  openCardForCell(next, target, player.id);
  return next;
}

function advancePlayer(state) {
  if (state.players.every(player => player.finished)) {
    state.status = 'complete';
    return;
  }
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const index = (state.currentPlayerIndex + offset) % state.players.length;
    if (!state.players[index].finished) { state.currentPlayerIndex = index; break; }
  }
  state.turnNumber += 1;
  state.dice = null;
}

export function finishCard(state, skipped = false) {
  if (!state.openCard) return state;
  const next = checkpoint(state);
  const card = next.openCard;
  const player = next.players.find(item => item.id === card.playerId);
  if (player && card.integration) {
    if (card.cell === 75) {
      player.position = 75;
      player.finished = true;
      addLog(next, skipped ? 'SKIP_CARD' : 'SAVE_INTEGRATION', `${player.name} завершила путь на ячейке 75`, player.id);
    } else {
      player.position = INTEGRATION_JUMPS[card.cell];
      addLog(next, skipped ? 'SKIP_CARD' : 'SAVE_INTEGRATION', `${player.name}: интеграция ${card.cell}, переход на ${player.position}`, player.id);
    }
  } else if (player) {
    addLog(next, skipped ? 'SKIP_CARD' : 'CONFIRM_CARD', `${player.name}: ${skipped ? 'карточка пропущена' : 'карточка подтверждена'} (${card.cell})`, player.id);
  }
  next.openCard = null;
  advancePlayer(next);
  return next;
}

export function reshuffleDeck(state, deck) {
  if (!MAIN_DECK_KEYS.includes(deck)) return state;
  const next = checkpoint(state);
  next.usedCards[deck] = [];
  addLog(next, 'RESHUFFLE_DECK', `Колода «${deck}» перемешана`);
  if (next.openCard?.exhausted && next.openCard.deck === deck) {
    const { cell, playerId } = next.openCard;
    next.openCard = chooseCard(next, deck, cell, playerId);
  }
  return next;
}

export function changeResource(state, playerId, kind, delta) {
  const sourcePlayer = state.players.find(item => item.id === playerId);
  if (!sourcePlayer || !['tokens', 'crystals'].includes(kind)) return state;
  if (delta < 0 && sourcePlayer.resources[kind].received - sourcePlayer.resources[kind].used <= 0) return state;
  const next = checkpoint(state);
  const player = next.players.find(item => item.id === playerId);
  if (!player || !['tokens', 'crystals'].includes(kind)) return state;
  const resource = player.resources[kind];
  if (delta > 0) resource.received += 1;
  if (delta < 0 && resource.received - resource.used > 0) resource.used += 1;
  addLog(next, delta > 0 ? 'ADD_RESOURCE' : 'USE_RESOURCE', `${player.name}: ${delta > 0 ? 'получен' : 'применён'} ${kind === 'tokens' ? 'жетон' : 'кристалл'}`, player.id);
  return next;
}

export function setPlayerPosition(state, playerId, position) {
  const value = Math.max(0, Math.min(75, Number(position) || 0));
  const next = checkpoint(state);
  const player = next.players.find(item => item.id === playerId);
  if (!player) return state;
  const before = player.position;
  player.position = value;
  player.finished = value === 75;
  addLog(next, 'MOVE_PLAYER', `${player.name}: позиция исправлена ${before} → ${value}`, player.id);
  return next;
}

export function selectNextPlayer(state) {
  const next = checkpoint(state);
  advancePlayer(next);
  addLog(next, 'SELECT_NEXT_PLAYER', `Ведущая вручную выбрала следующую участницу`);
  return next;
}

export function updateTransitionMap(state, playerId, field, value, integrationIndex = null) {
  const next = clone(state);
  const player = next.players.find(item => item.id === playerId);
  if (!player) return state;
  if (field === 'integrations' && integrationIndex !== null) player.transitionMap.integrations[integrationIndex] = value;
  else if (Object.hasOwn(player.transitionMap, field)) player.transitionMap[field] = value;
  return next;
}

export function undo(state) {
  if (!state.history?.length) return state;
  const restored = clone(state.history[state.history.length - 1]);
  restored.history = state.history.slice(0, -1);
  addLog(restored, 'UNDO', 'Отменено последнее игровое действие');
  return restored;
}

export function currentPlayer(state) { return state.players[state.currentPlayerIndex] || null; }
export function resourceBalance(resource) { return Math.max(0, resource.received - resource.used); }
