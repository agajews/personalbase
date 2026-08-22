-- Fact plane: the append-only event log. The only table replay depends on.
create table events (
  seq             bigint generated always as identity primary key,
  event_uid       uuid not null default gen_random_uuid(),
  type            text not null,
  schema_version  smallint not null,
  source          text not null,
  source_run_id   uuid,
  occurred_at     timestamptz not null,
  recorded_at     timestamptz not null default now(),
  payload         jsonb not null,
  idempotency_key text,
  caused_by_uid   uuid,
  corrects_uid    uuid,
  constraint events_uid_unique  unique (event_uid),
  constraint events_idem_unique unique (idempotency_key)
);
create index events_type_seq    on events (type, seq);
create index events_occurred    on events (occurred_at);
create index events_payload_gin on events using gin (payload jsonb_path_ops);

-- The single serialized append path. The advisory xact lock closes the
-- commit-visibility gap so "seq > cursor" consumption never skips an event.
-- The idempotency-key conflict clause makes every reactor re-runnable.
create function append_events(batch jsonb) returns integer
language plpgsql as $$
declare
  last_seq bigint;
  inserted_count integer;
begin
  perform pg_advisory_xact_lock(42);
  with inserted as (
    insert into events (type, schema_version, source, source_run_id, occurred_at,
                        payload, idempotency_key, caused_by_uid, corrects_uid)
    select e->>'type',
           (e->>'schema_version')::smallint,
           e->>'source',
           (e->>'source_run_id')::uuid,
           (e->>'occurred_at')::timestamptz,
           e->'payload',
           e->>'idempotency_key',
           (e->>'caused_by_uid')::uuid,
           (e->>'corrects_uid')::uuid
    from jsonb_array_elements(batch) as e
    on conflict (idempotency_key) do nothing
    returning seq
  )
  select max(seq), count(*)::integer into last_seq, inserted_count from inserted;
  if last_seq is not null then
    perform pg_notify('events', last_seq::text);
  end if;
  return inserted_count;  -- 0 when every event was an idempotent duplicate
end $$;

-- Operational plane: disposable coordination state, written by the kernel runtime.
create table checkpoints (
  process    text primary key,
  version    int not null,
  last_seq   bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table jobs (
  job_id     uuid primary key default gen_random_uuid(),
  process    text not null,
  payload    jsonb not null default '{}',
  run_after  timestamptz not null default now(),
  status     text not null default 'pending',
  attempts   int not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create index jobs_pending on jobs (run_after) where status = 'pending';

create table process_state (
  process    text primary key,
  state      jsonb not null,
  updated_at timestamptz not null default now()
);

create table runs (
  run_id        uuid primary key default gen_random_uuid(),
  process       text not null,
  job_id        uuid,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',
  input_summary jsonb,
  emitted_count int,
  tokens_in     bigint,
  tokens_out    bigint,
  error         text
);
create index runs_process on runs (process, started_at);
