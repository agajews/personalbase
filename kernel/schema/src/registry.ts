import type { z } from "zod";

/**
 * One version of an event type's payload shape. Versions are contiguous from 1.
 * `upcast` converts a payload of the previous version into this version; it is
 * required for every version except the first, and must be pure.
 */
export interface EventVersion {
  readonly schema: z.ZodType;
  readonly upcast?: (previous: unknown) => unknown;
}

export interface EventTypeDef {
  readonly type: string;
  /** Index 0 is version 1. */
  readonly versions: readonly EventVersion[];
}

export type SchemaRegistry = ReadonlyMap<string, EventTypeDef>;

export function makeRegistry(defs: readonly EventTypeDef[]): SchemaRegistry {
  const registry = new Map<string, EventTypeDef>();
  for (const def of defs) {
    if (registry.has(def.type)) {
      throw new Error(`duplicate event type: ${def.type}`);
    }
    if (def.versions.length === 0) {
      throw new Error(`event type ${def.type} has no versions`);
    }
    def.versions.forEach((version, i) => {
      if (i > 0 && version.upcast === undefined) {
        throw new Error(`event type ${def.type} v${i + 1} is missing an upcaster`);
      }
    });
    registry.set(def.type, def);
  }
  return registry;
}

function getDef(registry: SchemaRegistry, type: string): EventTypeDef {
  const def = registry.get(type);
  if (def === undefined) {
    throw new Error(`unknown event type: ${type}`);
  }
  return def;
}

export function latestVersion(registry: SchemaRegistry, type: string): number {
  return getDef(registry, type).versions.length;
}

/** Validates a payload against the schema for the exact version it claims. */
export function validatePayload(
  registry: SchemaRegistry,
  type: string,
  schemaVersion: number,
  payload: unknown,
): unknown {
  const def = getDef(registry, type);
  const version = def.versions[schemaVersion - 1];
  if (version === undefined) {
    throw new Error(`event type ${type} has no version ${schemaVersion}`);
  }
  return version.schema.parse(payload);
}

/**
 * Upcasts a stored payload through the chain of upcasters to the latest
 * version and validates it. Folds and reactors only ever see the result.
 */
export function upcastToLatest(
  registry: SchemaRegistry,
  type: string,
  schemaVersion: number,
  payload: unknown,
): { schemaVersion: number; payload: unknown } {
  const def = getDef(registry, type);
  let current = validatePayload(registry, type, schemaVersion, payload);
  for (let v = schemaVersion + 1; v <= def.versions.length; v++) {
    const version = def.versions[v - 1];
    if (version?.upcast === undefined) {
      throw new Error(`event type ${type} v${v} is missing an upcaster`);
    }
    current = version.schema.parse(version.upcast(current));
  }
  return { schemaVersion: def.versions.length, payload: current };
}
