-- Follow-up job chains (reactors watching long-lived external effects) need
-- retried runs to be unable to fork the chain: enqueues carry a unique key.
alter table jobs add column dedupe_key text;
create unique index jobs_dedupe_key on jobs (dedupe_key) where dedupe_key is not null;
