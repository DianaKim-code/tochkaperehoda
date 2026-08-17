-- «Точка перехода»: комнаты, приватные карты перехода и Realtime.
-- Выполнять целиком в Supabase SQL Editor от имени владельца проекта.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_user_id uuid not null references auth.users(id) on delete cascade,
  host_name text not null,
  status text not null default 'waiting',
  game_state jsonb,
  state_version bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  constraint rooms_code_format check (code ~ '^TP-[0-9]{4}$'),
  constraint rooms_status_check check (status in ('waiting', 'playing', 'completed', 'closed')),
  constraint rooms_host_name_length check (char_length(host_name) between 1 and 80),
  constraint rooms_state_version_nonnegative check (state_version >= 0),
  constraint rooms_game_state_object check (game_state is null or jsonb_typeof(game_state) = 'object')
);

create table if not exists public.room_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  color text not null,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  is_connected boolean not null default true,
  constraint room_players_name_length check (char_length(name) between 1 and 80),
  constraint room_players_color_check check (color in ('emerald', 'blue', 'purple', 'red', 'coral', 'turquoise')),
  constraint room_players_room_id_id_unique unique (room_id, id),
  constraint room_players_room_user_unique unique (room_id, user_id),
  constraint room_players_room_color_unique unique (room_id, color)
);

create table if not exists public.transition_maps (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint transition_maps_room_player_unique unique (room_id, player_id),
  constraint transition_maps_room_player_fk foreign key (room_id, player_id) references public.room_players(room_id, id) on delete cascade,
  constraint transition_maps_data_object check (jsonb_typeof(data) = 'object')
);

create index if not exists rooms_host_user_id_idx on public.rooms(host_user_id);
create index if not exists rooms_expires_at_idx on public.rooms(expires_at);
create index if not exists room_players_room_id_idx on public.room_players(room_id);
create index if not exists room_players_user_id_idx on public.room_players(user_id);
create index if not exists transition_maps_room_id_idx on public.transition_maps(room_id);
create index if not exists transition_maps_user_id_idx on public.transition_maps(user_id);

drop trigger if exists rooms_set_updated_at on public.rooms;
create trigger rooms_set_updated_at before update on public.rooms
for each row execute function public.set_updated_at();

drop trigger if exists transition_maps_set_updated_at on public.transition_maps;
create trigger transition_maps_set_updated_at before update on public.transition_maps
for each row execute function public.set_updated_at();

-- Эти помощники не раскрывают данные комнаты и позволяют политикам избежать рекурсии.
create or replace function public.is_room_host(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.rooms r
    where r.id = p_room_id and r.host_user_id = auth.uid()
  );
$$;

create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.room_players rp
    where rp.room_id = p_room_id and rp.user_id = auth.uid()
  );
$$;

alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.transition_maps enable row level security;

drop policy if exists rooms_select_participants on public.rooms;
create policy rooms_select_participants on public.rooms
for select to authenticated
using (public.is_room_host(id) or public.is_room_member(id));

drop policy if exists room_players_select_participants on public.room_players;
create policy room_players_select_participants on public.room_players
for select to authenticated
using (public.is_room_host(room_id) or public.is_room_member(room_id));

drop policy if exists transition_maps_select_owner_or_host on public.transition_maps;
create policy transition_maps_select_owner_or_host on public.transition_maps
for select to authenticated
using (user_id = auth.uid() or public.is_room_host(room_id));

-- Прямые записи запрещены. Изменения выполняются только функциями ниже.
revoke all on public.rooms, public.room_players, public.transition_maps from public, anon, authenticated;
grant select on public.rooms, public.room_players, public.transition_maps to authenticated;

create or replace function public.create_game_room(host_name text)
returns table (room_id uuid, room_code text, room_status text, room_host_name text, room_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_host_name text := trim(coalesce(host_name, ''));
  v_code text;
  v_room public.rooms%rowtype;
  v_attempt integer;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if char_length(v_host_name) < 1 or char_length(v_host_name) > 80 then raise exception 'INVALID_HOST_NAME'; end if;

  for v_attempt in 1..40 loop
    v_code := 'TP-' || lpad((floor(random() * 10000))::integer::text, 4, '0');
    begin
      insert into public.rooms (code, host_user_id, host_name)
      values (v_code, v_user_id, v_host_name)
      returning * into v_room;
      exit;
    exception when unique_violation then
      if v_attempt = 40 then raise exception 'ROOM_CODE_UNAVAILABLE'; end if;
    end;
  end loop;

  return query select v_room.id, v_room.code, v_room.status, v_room.host_name, v_room.expires_at;
end;
$$;

create or replace function public.get_room_join_info(room_code text)
returns table (normalized_code text, host_name text, room_status text, expires_at timestamptz, available_colors text[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(room_code, ''), '\s+', '', 'g'));
  v_room public.rooms%rowtype;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_code !~ '^TP-[0-9]{4}$' then raise exception 'INVALID_ROOM_CODE'; end if;

  select * into v_room from public.rooms r where r.code = v_code;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;

  return query
  select v_room.code, v_room.host_name, v_room.status, v_room.expires_at,
    coalesce(array(
      select color_name from unnest(array['emerald','blue','purple','red','coral','turquoise']) color_name
      where not exists (
        select 1 from public.room_players rp
        where rp.room_id = v_room.id and rp.color = color_name
      )
      order by array_position(array['emerald','blue','purple','red','coral','turquoise'], color_name)
    ), array[]::text[]);
end;
$$;

create or replace function public.join_game_room(room_code text, player_name text, player_color text)
returns table (room_id uuid, player_id uuid, normalized_code text, room_status text, room_host_name text, room_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_code text := upper(regexp_replace(coalesce(room_code, ''), '\s+', '', 'g'));
  v_name text := trim(coalesce(player_name, ''));
  v_color text := lower(trim(coalesce(player_color, '')));
  v_room public.rooms%rowtype;
  v_player public.room_players%rowtype;
  v_count integer;
begin
  if v_user_id is null then raise exception 'AUTH_REQUIRED'; end if;
  if v_code !~ '^TP-[0-9]{4}$' then raise exception 'INVALID_ROOM_CODE'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 80 then raise exception 'INVALID_PLAYER_NAME'; end if;
  if v_color not in ('emerald','blue','purple','red','coral','turquoise') then raise exception 'INVALID_PLAYER_COLOR'; end if;

  select * into v_room from public.rooms r where r.code = v_code for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.host_user_id = v_user_id then raise exception 'HOST_CANNOT_JOIN_AS_PLAYER'; end if;
  if v_room.status <> 'waiting' then raise exception 'ROOM_NOT_WAITING'; end if;
  if v_room.expires_at <= now() then raise exception 'ROOM_EXPIRED'; end if;

  select * into v_player from public.room_players rp
  where rp.room_id = v_room.id and rp.user_id = v_user_id;

  if found then
    if exists (
      select 1 from public.room_players rp
      where rp.room_id = v_room.id and rp.color = v_color and rp.user_id <> v_user_id
    ) then raise exception 'COLOR_TAKEN'; end if;
    update public.room_players
    set name = v_name, color = v_color, last_seen = now(), is_connected = true
    where id = v_player.id returning * into v_player;
  else
    select count(*) into v_count from public.room_players rp where rp.room_id = v_room.id;
    if v_count >= 6 then raise exception 'ROOM_FULL'; end if;
    if exists (select 1 from public.room_players rp where rp.room_id = v_room.id and rp.color = v_color) then
      raise exception 'COLOR_TAKEN';
    end if;
    insert into public.room_players (room_id, user_id, name, color)
    values (v_room.id, v_user_id, v_name, v_color)
    returning * into v_player;
  end if;

  insert into public.transition_maps (room_id, player_id, user_id, data)
  values (v_room.id, v_player.id, v_user_id, '{}'::jsonb)
  on conflict (room_id, player_id) do nothing;

  return query select v_room.id, v_player.id, v_room.code, v_room.status, v_room.host_name, v_room.expires_at;
exception when unique_violation then
  raise exception 'COLOR_TAKEN';
end;
$$;

create or replace function public.save_room_game_state(
  p_room_id uuid,
  p_expected_version bigint,
  p_game_state jsonb,
  p_status text default null
)
returns table (game_state jsonb, state_version bigint, room_status text, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_status text;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_room from public.rooms r where r.id = p_room_id for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.host_user_id <> auth.uid() then raise exception 'HOST_ONLY'; end if;
  if v_room.status = 'closed' or v_room.expires_at <= now() then raise exception 'ROOM_CLOSED'; end if;
  if v_room.state_version <> p_expected_version then raise exception 'STATE_VERSION_CONFLICT'; end if;
  if p_game_state is null or jsonb_typeof(p_game_state) <> 'object' then raise exception 'INVALID_GAME_STATE'; end if;
  if pg_column_size(p_game_state) > 1048576 then raise exception 'GAME_STATE_TOO_LARGE'; end if;
  if jsonb_path_exists(p_game_state, '$.**.transitionMap') then
    raise exception 'PRIVATE_MAP_IN_SHARED_STATE';
  end if;

  v_status := coalesce(p_status, v_room.status);
  if v_status not in ('waiting','playing','completed') then raise exception 'INVALID_ROOM_STATUS'; end if;

  update public.rooms r
  set game_state = p_game_state,
      state_version = r.state_version + 1,
      status = v_status
  where r.id = p_room_id
  returning r.game_state, r.state_version, r.status, r.updated_at
  into game_state, state_version, room_status, updated_at;
  return next;
end;
$$;

create or replace function public.save_transition_map(p_room_id uuid, p_player_id uuid, p_data jsonb)
returns table (player_id uuid, data jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_player public.room_players%rowtype;
  v_room public.rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'INVALID_MAP_DATA'; end if;
  if pg_column_size(p_data) > 65536 then raise exception 'MAP_DATA_TOO_LARGE'; end if;

  select * into v_room from public.rooms r where r.id = p_room_id;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.status = 'closed' or v_room.expires_at <= now() then raise exception 'ROOM_CLOSED'; end if;
  select * into v_player from public.room_players rp where rp.id = p_player_id and rp.room_id = p_room_id;
  if not found then raise exception 'PLAYER_NOT_FOUND'; end if;
  if auth.uid() <> v_player.user_id and auth.uid() <> v_room.host_user_id then raise exception 'MAP_ACCESS_DENIED'; end if;

  insert into public.transition_maps as tm (room_id, player_id, user_id, data)
  values (p_room_id, p_player_id, v_player.user_id, p_data)
  on conflict (room_id, player_id) do update set data = excluded.data
  returning tm.player_id, tm.data, tm.updated_at into player_id, data, updated_at;
  return next;
end;
$$;

create or replace function public.set_player_connection(p_room_id uuid, p_is_connected boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  update public.room_players
  set is_connected = p_is_connected, last_seen = now()
  where room_id = p_room_id and user_id = auth.uid();
end;
$$;

create or replace function public.leave_game_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if exists (select 1 from public.rooms r where r.id = p_room_id and r.host_user_id = auth.uid()) then
    raise exception 'HOST_MUST_CLOSE_ROOM';
  end if;
  delete from public.room_players rp where rp.room_id = p_room_id and rp.user_id = auth.uid();
end;
$$;

create or replace function public.remove_room_player(p_room_id uuid, p_player_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.is_room_host(p_room_id) then raise exception 'HOST_ONLY'; end if;
  delete from public.room_players rp where rp.room_id = p_room_id and rp.id = p_player_id;
end;
$$;

create or replace function public.close_game_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  update public.rooms r
  set status = 'closed', state_version = r.state_version + 1
  where r.id = p_room_id and r.host_user_id = auth.uid() and r.status <> 'closed';
  if not found then raise exception 'HOST_ONLY_OR_ROOM_CLOSED'; end if;
end;
$$;

revoke all on function public.is_room_host(uuid) from public, anon;
revoke all on function public.is_room_member(uuid) from public, anon;
revoke all on function public.create_game_room(text) from public, anon;
revoke all on function public.get_room_join_info(text) from public, anon;
revoke all on function public.join_game_room(text, text, text) from public, anon;
revoke all on function public.save_room_game_state(uuid, bigint, jsonb, text) from public, anon;
revoke all on function public.save_transition_map(uuid, uuid, jsonb) from public, anon;
revoke all on function public.set_player_connection(uuid, boolean) from public, anon;
revoke all on function public.leave_game_room(uuid) from public, anon;
revoke all on function public.remove_room_player(uuid, uuid) from public, anon;
revoke all on function public.close_game_room(uuid) from public, anon;

grant execute on function public.is_room_host(uuid) to authenticated;
grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.create_game_room(text) to authenticated;
grant execute on function public.get_room_join_info(text) to authenticated;
grant execute on function public.join_game_room(text, text, text) to authenticated;
grant execute on function public.save_room_game_state(uuid, bigint, jsonb, text) to authenticated;
grant execute on function public.save_transition_map(uuid, uuid, jsonb) to authenticated;
grant execute on function public.set_player_connection(uuid, boolean) to authenticated;
grant execute on function public.leave_game_room(uuid) to authenticated;
grant execute on function public.remove_room_player(uuid, uuid) to authenticated;
grant execute on function public.close_game_room(uuid) to authenticated;

alter table public.rooms replica identity full;
alter table public.room_players replica identity full;
alter table public.transition_maps replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then alter publication supabase_realtime add table public.rooms; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_players'
  ) then alter publication supabase_realtime add table public.room_players; end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'transition_maps'
  ) then alter publication supabase_realtime add table public.transition_maps; end if;
end;
$$;
