const SESSION_KEY = 'tochka-perehoda-room-v1';

export function normalizeRoomCode(value = '') {
  const compact = String(value).toUpperCase().replace(/\s+/g, '');
  if (/^\d{4}$/.test(compact)) return `TP-${compact}`;
  if (/^TP\d{4}$/.test(compact)) return `TP-${compact.slice(2)}`;
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
    player.transitionMap = structuredClone(maps.get(player.id) || {
      request: '', tensionStart: '', integrations: ['', '', '', '', ''], decision: '', firstStep: '',
      deadline: '', support: '', tensionEnd: '', takeaway: ''
    });
  });
  return copy;
}
