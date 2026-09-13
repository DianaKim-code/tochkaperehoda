import { getSupabase } from './supabase-client.js';

let channels = [];
let onlineHandler;

export async function subscribeToRoom(roomId, handlers) {
  await unsubscribeFromRoom();
  const supabase = await getSupabase();
  const status = value => handlers.onStatus?.(value);
  const watch = (table, callback, column = 'room_id') => {
    const channel = supabase.channel(`tp:${table}:${roomId}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter: `${column}=eq.${roomId}` }, callback)
      .subscribe(state => {
        if (state === 'SUBSCRIBED') status('Подключено');
        else if (['CHANNEL_ERROR', 'TIMED_OUT'].includes(state)) status('Переподключение…');
        else if (state === 'CLOSED') status('Нет соединения');
      });
    channels.push(channel);
  };
  watch('rooms', payload => handlers.onRoom?.(payload), 'id');
  watch('room_players', payload => handlers.onPlayers?.(payload));
  watch('transition_maps', payload => handlers.onMaps?.(payload));
  watch('participant_roll_requests', payload => handlers.onRollRequest?.(payload));
  onlineHandler = () => status(navigator.onLine ? 'Переподключение…' : 'Нет соединения');
  window.addEventListener('online', onlineHandler);
  window.addEventListener('offline', onlineHandler);
  status(navigator.onLine ? 'Подключение…' : 'Нет соединения');
}

export async function unsubscribeFromRoom() {
  if (onlineHandler) {
    window.removeEventListener('online', onlineHandler);
    window.removeEventListener('offline', onlineHandler);
    onlineHandler = null;
  }
  if (!channels.length) return;
  const supabase = await getSupabase();
  await Promise.all(channels.map(channel => supabase.removeChannel(channel)));
  channels = [];
}
