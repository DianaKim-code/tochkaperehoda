import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sql = await readFile(new URL('../supabase/migrations/001_multiplayer_rooms.sql', import.meta.url), 'utf8');
const rollSql = await readFile(new URL('../supabase/migrations/002_participant_roll_requests.sql', import.meta.url), 'utf8');

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

test('participant roll is server generated, versioned and idempotent', () => {
  assert.match(rollSql, /unique \(room_id, state_version\)/);
  assert.match(rollSql, /roll_value between 1 and 6/);
  assert.match(rollSql, /floor\(random\(\) \* 6 \+ 1\)::smallint/);
  assert.match(rollSql, /v_room\.state_version <> p_expected_version.*STATE_VERSION_CONFLICT/s);
  assert.match(rollSql, /on conflict on constraint participant_roll_requests_room_version_unique do nothing/);
  assert.doesNotMatch(rollSql, /request_participant_roll\([\s\S]{0,120}roll_value/i);
});

test('participant roll RPC validates membership, turn, room and open card', () => {
  const requestStart = rollSql.indexOf('create or replace function public.request_participant_roll');
  const requestEnd = rollSql.indexOf('create or replace function public.complete_participant_roll');
  const requestBody = rollSql.slice(requestStart, requestEnd);
  assert.match(requestBody, /status = 'closed'.*ROOM_CLOSED/s);
  assert.match(requestBody, /status <> 'playing'.*GAME_NOT_STARTED/s);
  assert.match(requestBody, /jsonb_typeof\(v_room\.game_state -> 'openCard'\).*CARD_ALREADY_OPEN/s);
  assert.match(requestBody, /room_id = p_room_id and rp\.user_id = v_user_id.*PLAYER_NOT_FOUND/s);
  assert.match(requestBody, /v_current_player_id <> v_player\.id::text.*NOT_CURRENT_PLAYER/s);
});

test('new table remains read-only and host-only save permissions stay unchanged', () => {
  assert.match(rollSql, /revoke all on public\.participant_roll_requests from public, anon, authenticated;/);
  assert.match(rollSql, /create policy participant_roll_requests_select_host[\s\S]*public\.is_room_host\(room_id\)/);
  assert.match(rollSql, /revoke all on function public\.request_participant_roll\(uuid, bigint\) from public, anon, authenticated;/);
  assert.match(rollSql, /grant execute on function public\.request_participant_roll\(uuid, bigint\) to authenticated;/);
  assert.match(sql, /if v_room\.host_user_id <> auth\.uid\(\) then raise exception 'HOST_ONLY'/);
});

test('only the host can acknowledge a roll after state version advances', () => {
  const completeStart = rollSql.indexOf('create or replace function public.complete_participant_roll');
  const completeBody = rollSql.slice(completeStart);
  assert.match(completeBody, /host_user_id <> auth\.uid\(\).*HOST_ONLY/s);
  assert.match(completeBody, /state_version <= v_request\.state_version.*ROLL_REQUEST_NOT_READY/s);
});
