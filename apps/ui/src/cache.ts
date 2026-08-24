import { useCallback, useEffect, useRef, useState } from "react";

// Last successful response per key. Module-level so it outlives view
// unmounts: navigating back to a view renders its previous data
// immediately while a fresh fetch replaces it in the background.
const cache = new Map<string, unknown>();

interface Fetched<T> {
  key: string;
  data: T | null;
  error: string | null;
}

/**
 * Stale-while-revalidate fetch. Returns the cached value for `key` right
 * away (null on first visit), runs `fetch`, and re-renders with the fresh
 * result. `refresh` refetches without dropping the currently shown data —
 * use it after mutations and for polling.
 */
export function useCached<T>(
  key: string,
  fetch: () => Promise<T>,
): { data: T | null; error: string | null; refresh: () => void } {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Fetched<T>>(() => ({
    key,
    data: (cache.get(key) as T | undefined) ?? null,
    error: null,
  }));

  // Callers pass a fresh closure every render; the effect reads the latest
  // one through a ref so it only re-runs when the key or tick changes.
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    let stale = false;
    fetchRef.current().then(
      (data) => {
        if (!stale) {
          cache.set(key, data);
          setState({ key, data, error: null });
        }
      },
      (e: unknown) => {
        if (!stale) {
          setState((prev) => ({
            key,
            data: prev.key === key ? prev.data : null,
            error: e instanceof Error ? e.message : String(e),
          }));
        }
      },
    );
    return () => {
      stale = true;
    };
  }, [key, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Right after a key change, state still holds the previous key's data;
  // serve the new key's cached value until its fetch lands.
  if (state.key !== key) {
    return { data: (cache.get(key) as T | undefined) ?? null, error: null, refresh };
  }
  return { data: state.data, error: state.error, refresh };
}
