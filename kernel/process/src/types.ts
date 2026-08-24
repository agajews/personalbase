import type {
  EventTypePattern,
  NewEvent,
  Sql,
  StoredEvent,
  TransactionSql,
} from "@nc/log";

/**
 * A fold is pure: it derives tables from events and may be truncated and
 * replayed at any time. Bumping `version` triggers an automatic rebuild from
 * seq 0. `apply` receives a batch in seq order and must be deterministic and
 * write only to `tables`; set-based writes (deduped in memory, one multi-row
 * upsert per table) keep round trips per batch constant instead of per event.
 */
export interface Fold {
  readonly kind: "fold";
  readonly name: string;
  readonly version: number;
  readonly consumes: readonly EventTypePattern[];
  readonly tables: readonly string[];
  init(tx: TransactionSql): Promise<void>;
  apply(tx: TransactionSql, events: readonly StoredEvent[]): Promise<void>;
}

/**
 * When a cron reactor is due: a rolling interval since its last run, or once
 * per day at a fixed hour (0-23) in an IANA time zone.
 */
export type CronSchedule =
  | { readonly intervalHours: number }
  | { readonly dailyAtHour: number; readonly timeZone: string };

export type ReactorTrigger =
  | { readonly kind: "event"; readonly consumes: readonly EventTypePattern[] }
  | { readonly kind: "cron"; readonly schedule: CronSchedule; readonly payload: unknown }
  | { readonly kind: "manual" };

export type ReactorInput =
  | { readonly kind: "event"; readonly event: StoredEvent }
  | { readonly kind: "job"; readonly payload: unknown };

/** What a reactor returns; the runner stamps source and sourceRunId. */
export type ReactorEvent = Omit<NewEvent, "source" | "sourceRunId">;

/**
 * A job a reactor asks the runner to enqueue after its events are appended.
 * This is how a reactor watching a long-lived external effect (a cloud
 * sandbox, a slow remote job) schedules its own next look without holding the
 * serial dispatcher: each run is quick and chains the next via a follow-up.
 */
export interface FollowUpJob {
  readonly process: string;
  readonly payload: unknown;
  /** Seconds before the job becomes due (default 0). */
  readonly runAfterSeconds?: number;
  /**
   * Unique key; a follow-up whose key already exists is dropped, so a
   * retried reactor run cannot fork the job chain it is part of.
   */
  readonly dedupeKey?: string;
}

export interface ReactorOutput {
  readonly events: readonly ReactorEvent[];
  readonly followUps?: readonly FollowUpJob[];
}

export type ReactorResult = readonly ReactorEvent[] | ReactorOutput;

export interface ReactorCtx {
  /** Read-only access to fold tables (by convention; reactors never write tables). */
  readonly sql: Sql;
  /** Reactor-private operational state (world cursors etc.), not facts. */
  getState(): Promise<unknown>;
  setState(state: unknown): Promise<void>;
  /** Accumulates LLM token usage into the run record. */
  recordUsage(usage: { readonly tokensIn: number; readonly tokensOut: number }): void;
}

/**
 * A reactor is effectful: it runs at most once per trigger, never on replay,
 * and its only output is events. Emission must be idempotent via idempotency
 * keys so a retried run cannot double-post.
 */
export interface Reactor {
  readonly kind: "reactor";
  readonly name: string;
  readonly trigger: ReactorTrigger;
  run(ctx: ReactorCtx, input: ReactorInput): Promise<ReactorResult>;
}

export type Process = Fold | Reactor;
