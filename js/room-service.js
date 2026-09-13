import { ensureAnonymousSession } from './supabase-client.js';
import { normalizeRoomCode } from './online-storage.js';

const ERROR_MESSAGES = {
  AUTH_REQUIRED: 'Не удалось выполнить анонимный вход.', INVALID_ROOM_CODE: 'Введите код вида TP-482701.',
  ROOM_NOT_FOUND: 'Комната не найдена.', ROOM_NOT_WAITING: 'Игра в этой комнате уже началась.',
  ROOM_EXPIRED: 'Срок действия комнаты истёк.', ROOM_CLOSED: 'Комната закрыта.', ROOM_FULL: 'В комнате уже 6 участниц.',
  COLOR_TAKEN: 'Эта фишка уже занята.', INVALID_HOST_NAME: 'Укажите имя ведущей.', INVALID_PLAYER_NAME: 'Укажите имя участницы.',
  HOST_CANNOT_JOIN_AS_PLAYER: 'Ведущая уже находится в этой комнате.', HOST_ONLY: 'Это действие доступно только ведущей.',
  STATE_VERSION_CONFLICT: 'Состояние комнаты обновилось. Повторите действие.', MAP_ACCESS_DENIED: 'Эта карта перехода недоступна.',
  ACTIVE_ROOM_EXISTS: 'У вас уже есть активная комната. Вернитесь в неё или сначала закройте её.',
  PLAYER_NOT_FOUND: 'Вы больше не участвуете в этой комнате.', NOT_CURRENT_PLAYER: 'Сейчас ход другой участницы.',
  GAME_NOT_STARTED: 'Игра ещё не началась.', CARD_ALREADY_OPEN: 'Сначала ведущая должна завершить открытую карточку.',
  ROLL_REQUEST_NOT_READY: 'Бросок ещё не применён ведущей.'
};

export function describeRoomError(error) {
  const source = `${error?.message || ''} ${error?.details || ''}`;
  const key = Object.keys(ERROR_MESSAGES).find(code => source.includes(code));
  if (error?.code === 'PGRST116' || source.includes('Cannot coerce the result to a single JSON object')) {
    return 'Доступ к комнате завершён. Возможно, ведущая удалила вас или комната больше недоступна.';
  }
  return key ? ERROR_MESSAGES[key] : (error?.message || 'Не удалось связаться с комнатой.');
}

function friendly(error) {
  const source = `${error?.message || ''} ${error?.details || ''}`;
  const key = Object.keys(ERROR_MESSAGES).find(code => source.includes(code));
  const next = new Error(describeRoomError(error));
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
export const requestParticipantRoll = (roomId, version) => rpc('request_participant_roll', { p_room_id: roomId, p_expected_version: version });
export const completeParticipantRoll = requestId => rpc('complete_participant_roll', { p_request_id: requestId });

export async function loadPendingRollRequests(roomId) {
  const { supabase } = await ensureAnonymousSession();
  const { data, error } = await supabase.from('participant_roll_requests')
    .select('id,room_id,player_id,state_version,roll_value,status,created_at')
    .eq('room_id', roomId)
    .eq('status', 'pending')
    .order('created_at');
  if (error) throw friendly(error);
  return data || [];
}

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

export async function findRoomAccessByCode(code) {
  const { supabase, session } = await ensureAnonymousSession();
  const { data, error } = await supabase.from('rooms')
    .select('id,code,host_user_id')
    .eq('code', normalizeRoomCode(code))
    .maybeSingle();
  if (error) throw friendly(error);
  if (!data) return null;
  if (data.host_user_id === session.user.id) return { roomId: data.id, code: data.code, role: 'host', playerId: null };
  const { data: player, error: playerError } = await supabase.from('room_players')
    .select('id')
    .eq('room_id', data.id)
    .eq('user_id', session.user.id)
    .maybeSingle();
  if (playerError) throw friendly(playerError);
  return player ? { roomId: data.id, code: data.code, role: 'participant', playerId: player.id } : null;
}
