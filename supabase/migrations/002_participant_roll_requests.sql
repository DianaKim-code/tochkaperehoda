-- «Точка перехода»: безопасные запросы броска от текущей участницы.
-- Выполнять целиком в Supabase SQL Editor после 001_multiplayer_rooms.sql.

create table if not exists public.participant_roll_requests (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  state_version bigint not null,
  roll_value smallint not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint participant_roll_requests_room_player_fk
    foreign key (room_id, player_id) references public.room_players(room_id, id) on delete cascade,
  constraint participant_roll_requests_room_version_unique unique (room_id, state_version),
  constraint participant_roll_requests_value_check check (roll_value between 1 and 6),
  constraint participant_roll_requests_status_check check (status in ('pending', 'processed')),
  constraint participant_roll_requests_version_nonnegative check (state_version >= 0)
);

create index if not exists participant_roll_requests_room_pending_idx
  on public.participant_roll_requests(room_id, status, created_at);
create index if not exists participant_roll_requests_user_id_idx
  on public.participant_roll_requests(user_id);

alter table public.participant_roll_requests enable row level security;

drop policy if exists participant_roll_requests_select_host on public.participant_roll_requests;
create policy participant_roll_requests_select_host on public.participant_roll_requests
for select to authenticated
using (public.is_room_host(room_id));

-- Клиентские роли не записывают таблицу напрямую. Участница создаёт запрос только через RPC,
-- а ведущая получает минимальный read-only поток для обработки через Realtime.
revoke all on public.participant_roll_requests from public, anon, authenticated;
grant select on public.participant_roll_requests to authenticated;

create or replace function public.request_participant_roll(
  p_room_id uuid,
  p_expected_version bigint
)
returns table (request_id uuid, state_version bigint, request_status text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_player public.room_players%rowtype;
  v_request public.participant_roll_requests%rowtype;
  v_current_index integer;
  v_current_player_id text;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;

  select * into v_room from public.rooms r where r.id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.expires_at <= now() then raise exception 'ROOM_EXPIRED'; end if;
  if v_room.status = 'closed' then raise exception 'ROOM_CLOSED'; end if;
  if v_room.status <> 'playing' then raise exception 'GAME_NOT_STARTED'; end if;
  if v_room.state_version <> p_expected_version then raise exception 'STATE_VERSION_CONFLICT'; end if;
  if v_room.game_state is null or jsonb_typeof(v_room.game_state) <> 'object' then raise exception 'INVALID_GAME_STATE'; end if;
  if coalesce(jsonb_typeof(v_room.game_state -> 'openCard'), 'null') <> 'null' then raise exception 'CARD_ALREADY_OPEN'; end if;

  select * into v_player from public.room_players rp
  where rp.room_id = p_room_id and rp.user_id = v_user_id;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;

  begin
    v_current_index := (v_room.game_state ->> 'currentPlayerIndex')::integer;
    v_current_player_id := v_room.game_state -> 'players' -> v_current_index ->> 'id';
  exception when others then
    raise exception 'INVALID_GAME_STATE';
  end;

  if v_current_player_id is null or v_current_player_id <> v_player.id::text then raise exception 'NOT_CURRENT_PLAYER'; end if;
  if coalesce((v_room.game_state -> 'players' -> v_current_index ->> 'finished')::boolean, false) then raise exception 'NOT_CURRENT_PLAYER'; end if;

  insert into public.participant_roll_requests (room_id, player_id, user_id, state_version, roll_value)
  values (p_room_id, v_player.id, v_user_id, p_expected_version, floor(random() * 6 + 1)::smallint)
  on conflict on constraint participant_roll_requests_room_version_unique do nothing
  returning * into v_request;

  if not found then
    select * into v_request from public.participant_roll_requests pr
    where pr.room_id = p_room_id and pr.state_version = p_expected_version;
    if not found or v_request.user_id <> v_user_id or v_request.player_id <> v_player.id then
      raise exception 'ROLL_ALREADY_REQUESTED';
    end if;
  end if;

  return query select v_request.id, v_request.state_version, v_request.status;
end;
$$;

create or replace function public.complete_participant_roll(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.participant_roll_requests%rowtype;
  v_room public.rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;

  select * into v_request from public.participant_roll_requests pr
  where pr.id = p_request_id for update;
  if not found then raise exception 'ROLL_REQUEST_NOT_FOUND'; end if;

  select * into v_room from public.rooms r where r.id = v_request.room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.host_user_id <> auth.uid() then raise exception 'HOST_ONLY'; end if;
  if v_request.status = 'processed' then return; end if;
  if v_room.state_version <= v_request.state_version then raise exception 'ROLL_REQUEST_NOT_READY'; end if;

  update public.participant_roll_requests
  set status = 'processed', processed_at = now()
  where id = p_request_id;
end;
$$;

revoke all on function public.request_participant_roll(uuid, bigint) from public, anon, authenticated;
revoke all on function public.complete_participant_roll(uuid) from public, anon, authenticated;
grant execute on function public.request_participant_roll(uuid, bigint) to authenticated;
grant execute on function public.complete_participant_roll(uuid) to authenticated;

alter table public.participant_roll_requests replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'participant_roll_requests'
  ) then
    alter publication supabase_realtime add table public.participant_roll_requests;
  end if;
end;
$$;
