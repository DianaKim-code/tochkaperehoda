import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/001_multiplayer_rooms.sql', import.meta.url), 'utf8');

test('migration consistently uses six-digit room codes', () => {
  assert.match(sql, /rooms_code_format check \(code ~ '\^TP-\[0-9\]\{6\}\$'\)/);
  assert.match(sql, /random\(\) \* 1000000/);
  assert.match(sql, /::integer::text, 6, '0'/);
  assert.equal((sql.match(/\^TP-\[0-9\]\{6\}\$/g) || []).length, 3);
  assert.doesNotMatch(sql, /\^TP-\[0-9\]\{4\}\$/);
});

test('join preview rejects rooms that cannot be joined', () => {
  const start = sql.indexOf('create or replace function public.get_room_join_info');
  const end = sql.indexOf('create or replace function public.join_game_room');
  const body = sql.slice(start, end);
  assert.match(body, /expires_at <= now\(\).*ROOM_EXPIRED/s);
  assert.match(body, /status = 'closed'.*ROOM_CLOSED/s);
  assert.match(body, /status <> 'waiting'.*ROOM_NOT_WAITING/s);
});

test('room creation is rate-limited per active host and trigger helper is revoked', () => {
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(v_user_id::text, 0\)\)/);
  assert.match(sql, /host_user_id = v_user_id[\s\S]*status in \('waiting', 'playing'\)[\s\S]*expires_at > now\(\)[\s\S]*ACTIVE_ROOM_EXISTS/);
  assert.match(sql, /revoke all on function public\.set_updated_at\(\) from public, anon, authenticated;/);
});

test('transition map upserts use a named constraint without output-parameter ambiguity', () => {
  assert.equal((sql.match(/on conflict on constraint transition_maps_room_player_unique/g) || []).length, 2);
  assert.doesNotMatch(sql, /on conflict \(room_id, player_id\)/);
});
