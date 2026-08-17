import { ensureAnonymousSession } from './supabase-client.js';
import { normalizeRoomCode } from './online-storage.js';

const ERROR_MESSAGES = {
  AUTH_REQUIRED: 'Не удалось выполнить анонимный вход.', INVALID_ROOM_CODE: 'Введите код вида TP-482701.',
  ROOM_NOT_FOUND: 'Комната не найдена.', ROOM_NOT_WAITING: 'Игра в этой комнате уже началась.',
  ROOM_EXPIRED: 'Срок действия комнаты истёк.', ROOM_CLOSED: 'Комната закрыта.', ROOM_FULL: 'В комнате уже 6 участниц.',
  COLOR_TAKEN: 'Эта фишка уже занята.', INVALID_HOST_NAME: 'Укажите имя ведущей.', INVALID_PLAYER_NAME: 'Укажите имя участницы.',
  HOST_CANNOT_JOIN_AS_PLAYER: 'Ведущая уже находится в этой комнате.', HOST_ONLY: 'Это действие доступно только ведущей.',
  STATE_VERSION_CONFLICT: 'Состояние комнаты обновилось. Повторите действие.', MAP_ACCESS_DENIED: 'Эта карта перехода недоступна.',
  ACTIVE_ROOM_EXISTS: 'У вас уже есть активная комната. Вернитесь в неё или сначала закройте её.'
};

function friendly(error) {
  const source = `${error?.message || ''} ${error?.details || ''}`;
  const key = Object.keys(ERROR_MESSAGES).find(code => source.includes(code));
  const next = new Error(key ? ERROR_MESSAGES[key] : (error?.message || 'Не удалось связаться с комнатой.'));
  next.code = key || error?.code;
  return next;
}

async function rpc(name, args = {}) {
  const { supabase } = await ensureAnonymousSession();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw friendly(error);
  return Array.isArray(data) && data.length === 1 ? data[0] : data;
}

export const createRoom = hostName => rpc('create_game_room', { host_name: hostName });
export const getJoinInfo = code => rpc('get_room_join_info', { room_code: normalizeRoomCode(code) });
export const joinRoom = (code, name, color) => rpc('join_game_room', { room_code: normalizeRoomCode(code), player_name: name, player_color: color });
export const saveRoomState = (roomId, version, gameState, status = null) => rpc('save_room_game_state', { p_room_id: roomId, p_expected_version: version, p_game_state: gameState, p_status: status });
export const saveMap = (roomId, playerId, data) => rpc('save_transition_map', { p_room_id: roomId, p_player_id: playerId, p_data: data });
export const setConnection = (roomId, connected) => rpc('set_player_connection', { p_room_id: roomId, p_is_connected: connected });
export const leaveRoom = roomId => rpc('leave_game_room', { p_room_id: roomId });
export const removePlayer = (roomId, playerId) => rpc('remove_room_player', { p_room_id: roomId, p_player_id: playerId });
export const closeRoom = roomId => rpc('close_game_room', { p_room_id: roomId });

export async function loadRoom(roomId) {
  const { supabase } = await ensureAnonymousSession();
  const [roomResult, playersResult, mapsResult] = await Promise.all([
    supabase.from('rooms').select('*').eq('id', roomId).single(),
    supabase.from('room_players').select('*').eq('room_id', roomId).order('joined_at'),
    supabase.from('transition_maps').select('player_id,data,updated_at').eq('room_id', roomId)
  ]);
  if (roomResult.error) throw friendly(roomResult.error);
  if (playersResult.error) throw friendly(playersResult.error);
  if (mapsResult.error) throw friendly(mapsResult.error);
  return { room: roomResult.data, players: playersResult.data, maps: mapsResult.data };
}
