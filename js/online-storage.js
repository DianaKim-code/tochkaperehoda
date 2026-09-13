const SESSION_KEY = 'tochka-perehoda-room-v1';

export function normalizeRoomCode(value = '') {
  const compact = String(value).toUpperCase().replace(/\s+/g, '');
  if (/^\d{6}$/.test(compact)) return `TP-${compact}`;
  if (/^TP\d{6}$/.test(compact)) return `TP-${compact.slice(2)}`;
  return compact;
}

export function readRoomSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)) || null; } catch { return null; }
}

export function writeRoomSession(value) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(value));
}

export function clearRoomSession() {
  localStorage.removeItem(SESSION_KEY);
}

export function shouldRestoreRoomSession(queryCode, session) {
  if (!session?.roomId || !session?.role) return false;
  return true;
}

export function participantRollUiState(state, playerId, pendingVersion = null, connectionState = 'Подключено') {
  const current = state?.players?.[state.currentPlayerIndex] || null;
  if (connectionState !== 'Подключено') return { disabled: true, label: 'Нет соединения', reason: 'Проверьте подключение к интернету.' };
  if (!state || state.status !== 'playing' || !current) return { disabled: true, label: 'Игра ещё не началась', reason: 'Ожидайте начала игры.' };
  if (state.openCard) return { disabled: true, label: 'Карточка открыта', reason: 'Ожидайте действия ведущей.' };
  if (pendingVersion != null) return { disabled: true, label: 'Ожидаем ведущую…', reason: 'Бросок отправлен и ожидает синхронизации.' };
  if (current.id !== playerId) return { disabled: true, label: `Сейчас ход: ${current.name}`, reason: 'Кнопка станет доступна в ваш ход.' };
  if (current.finished) return { disabled: true, label: 'Путь завершён', reason: 'Ваш путь уже завершён.' };
  return { disabled: false, label: 'Бросить кубик', reason: 'Нажмите, чтобы бросить кубик.' };
}

export function sanitizeSharedState(value) {
  const copy = structuredClone(value);
  const strip = state => state?.players?.forEach(player => delete player.transitionMap);
  strip(copy);
  copy?.history?.forEach(strip);
  return copy;
}

export function attachPrivateMaps(state, maps = new Map()) {
  const copy = structuredClone(state);
  copy.players?.forEach(player => {
    const emptyMap = {
      request: '', tensionStart: '', integrations: ['', '', '', '', ''], decision: '', firstStep: '',
      deadline: '', support: '', tensionEnd: '', takeaway: ''
    };
    const stored = maps.get(player.id) || {};
    player.transitionMap = { ...emptyMap, ...structuredClone(stored) };
    player.transitionMap.integrations = Array.from({ length: 5 }, (_, index) => stored.integrations?.[index] || '');
  });
  return copy;
}
