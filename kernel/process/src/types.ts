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
 * seq 0. `apply` must be deterministic and must write only to `tables`.
 */
export interface Fold {
  readonly kind: "fold";
  readonly name: string;
  readonly version: number;
  readonly consumes: readonly EventTypePattern[];
  readonly tables: readonly string[];
  init(tx: TransactionSql): Promise<void>;
  apply(tx: TransactionSql, event: StoredEvent): Promise<void>;
}

export type ReactorTrigger =
  | { readonly kind: "event"; readonly consumes: readonly EventTypePattern[] }
  | { readonly kind: "cron"; readonly intervalHours: number; readonly payload: unknown }
  | { readonly kind: "manual" };

export type ReactorInput =
  | { readonly kind: "event"; readonly event: StoredEvent }
  | { readonly kind: "job"; readonly payload: unknown };

/** What a reactor returns; the runner stamps source and sourceRunId. */
export type ReactorEvent = Omit<NewEvent, "source" | "sourceRunId">;

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
  run(ctx: ReactorCtx, input: ReactorInput): Promise<ReactorEvent[]>;
}

export type Process = Fold | Reactor;
