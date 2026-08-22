import { v5 as uuidv5 } from "uuid";

// Stable namespace for all entity ids. Deterministic minting means replay
// always produces the same ids and independent producers converge.
const entityNamespace = uuidv5("newcomputer.entities", uuidv5.URL);

export function entityId(kind: string, externalId: string): string {
  return uuidv5(`${kind}:${externalId}`, entityNamespace);
}
