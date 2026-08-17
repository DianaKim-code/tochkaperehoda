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
  return !queryCode || normalizeRoomCode(queryCode) === normalizeRoomCode(session.code);
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
