"""Control database: platform metadata, grants, and the append-only audit log."""

BOOTSTRAP = r"""
create schema if not exists a2w_control;
revoke all on schema a2w_control from public;

create table if not exists a2w_control.applications (
  id serial primary key,
  slug text unique not null check (slug ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null,
  description text not null default '',
  icon text not null default 'app',
  owner_id text not null,
  status text not null default 'published' check (status in ('published','unpublished')),
  classification text not null check (classification in ('general','personal','sensitive')),
  current_version int not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists a2w_control.app_versions (
  app_id int not null references a2w_control.applications(id),
  version int not null,
  definition jsonb not null,
  published_at timestamptz not null default now(),
  published_by text not null,
  primary key (app_id, version)
);

create table if not exists a2w_control.import_jobs (
  id serial primary key,
  owner_id text not null,
  status text not null default 'analysed' check (status in ('analysed','published','failed')),
  extraction jsonb not null,
  definition jsonb not null,
  classification jsonb not null,
  app_id int references a2w_control.applications(id),
  created_at timestamptz not null default now()
);

create table if not exists a2w_control.conversion_items (
  id serial primary key,
  job_id int not null references a2w_control.import_jobs(id) on delete cascade,
  object_type text not null,
  name text not null,
  status text not null check (status in ('converted','partly_converted','not_converted')),
  reason text not null default '',
  vba_class text,
  suggestion text
);

create table if not exists a2w_control.grants (
  id serial primary key,
  app_id int not null references a2w_control.applications(id) on delete cascade,
  subject_type text not null check (subject_type in ('user','group','role')),
  subject_id text not null,
  resource_type text not null check (resource_type in ('application','table','form','report')),
  resource_id text not null default '',
  level text not null check (level in ('open_application','view_data','edit_data','delete_data',
                                       'run_reports','design_application','manage_application')),
  granted_by text not null,
  granted_at timestamptz not null default now(),
  check ((resource_type = 'application') = (resource_id = '')),
  unique (app_id, subject_type, subject_id, resource_type, resource_id, level)
);

-- A saved draft of the next version of an application, held by one person at a time. The lock is a lease: it ends
-- at expires_at, and each save extends it, so a closed tab does not block everyone else for ever.
create table if not exists a2w_control.drafts (
  app_id int primary key references a2w_control.applications(id),
  locked_by text not null,
  locked_at timestamptz not null default now(),
  base_version int not null,
  log jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null
);

create table if not exists a2w_control.audit_events (
  seq bigserial primary key,
  ts timestamptz not null default clock_timestamp(),
  actor text not null,
  app text not null default '',
  object text not null default '',
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  prev_hash text not null,
  hash text not null
);

create or replace function a2w_control.audit_block() returns trigger language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end $$;

drop trigger if exists audit_no_change on a2w_control.audit_events;
create trigger audit_no_change before update or delete on a2w_control.audit_events
  for each row execute function a2w_control.audit_block();
drop trigger if exists audit_no_truncate on a2w_control.audit_events;
create trigger audit_no_truncate before truncate on a2w_control.audit_events
  for each statement execute function a2w_control.audit_block();

create or replace function a2w_control.audit_hash(p_prev text, p_seq bigint, p_ts timestamptz,
  p_actor text, p_app text, p_object text, p_action text, p_detail jsonb) returns text
language sql immutable as $$
  select encode(sha256(convert_to(concat_ws('|', p_prev, p_seq::text,
    to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'), p_actor, p_app, p_object, p_action, p_detail::text),
    'UTF8')), 'hex')
$$;

create or replace function a2w_control.audit_append(p_actor text, p_app text, p_object text,
  p_action text, p_detail jsonb) returns bigint
language plpgsql security definer set search_path = a2w_control, pg_catalog as $$
declare v_prev text; v_seq bigint; v_ts timestamptz := clock_timestamp();
begin
  perform pg_advisory_xact_lock(7001);
  select hash into v_prev from audit_events order by seq desc limit 1;
  v_prev := coalesce(v_prev, repeat('0', 64));
  v_seq := nextval('audit_events_seq_seq');
  insert into audit_events(seq, ts, actor, app, object, action, detail, prev_hash, hash)
  values (v_seq, v_ts, p_actor, p_app, p_object, p_action, p_detail, v_prev,
          audit_hash(v_prev, v_seq, v_ts, p_actor, p_app, p_object, p_action, p_detail));
  return v_seq;
end $$;

-- Returns the first sequence number whose hash or link is wrong, or null when the chain is intact.
create or replace function a2w_control.audit_verify() returns bigint
language plpgsql stable set search_path = a2w_control, pg_catalog as $$
declare r record; v_prev text := repeat('0', 64);
begin
  for r in select * from audit_events order by seq loop
    if r.prev_hash <> v_prev or r.hash <> audit_hash(r.prev_hash, r.seq, r.ts, r.actor, r.app, r.object, r.action, r.detail) then
      return r.seq;
    end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;

create or replace function a2w_control.record_change() returns trigger
language plpgsql security definer set search_path = a2w_control, pg_catalog as $$
declare v_user text := nullif(current_setting('a2w.user', true), '');
        v_old jsonb; v_new jsonb;
begin
  if v_user is null then
    raise exception 'record change without a user context is not allowed';
  end if;
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  perform audit_append(v_user, substr(tg_table_schema, 5), tg_table_name, lower(tg_op),
                       jsonb_build_object('old', v_old, 'new', v_new));
  return null;
end $$;

revoke all on function a2w_control.audit_append(text, text, text, text, jsonb) from public;
revoke all on function a2w_control.record_change() from public;
"""
