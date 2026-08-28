import { useEffect, useRef, useState } from "react";
import { api, type SubmittedLink } from "./api.js";
import { urlLabel } from "./ui.js";

// The rail's paste-a-link box. Submitting appends user.link.submitted — the
// URL and the tier it lands on in one fact — and the entity exists by the
// time the response lands, so the row below the box links straight at it.
// Its title arrives seconds later, when reactor:link-ingest has read the
// page, so each fresh row polls its entity until it has a name.

const pollMs = 3000;
// ~90 seconds; a page that hasn't answered by then isn't going to, and the
// row keeps its URL as its name either way.
const pollLimit = 30;

export function LinkBox({ onSubmitted }: { onSubmitted: () => void }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState<SubmittedLink[]>([]);

  const pastedRef = useRef(pasted);
  pastedRef.current = pasted;
  const waiting = pasted.some((link) => link.title === null);

  useEffect(() => {
    if (!waiting) {
      return;
    }
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > pollLimit) {
        clearInterval(timer);
        return;
      }
      for (const link of pastedRef.current) {
        if (link.title !== null) {
          continue;
        }
        void api.entity(link.entityId).then(
          (page) => {
            const title = page.entity.displayName;
            if (title !== null) {
              setPasted((current) =>
                current.map((l) => (l.entityId === link.entityId ? { ...l, title } : l)),
              );
            }
          },
          () => undefined, // the entity fold may not have caught up yet
        );
      }
    }, pollMs);
    return () => clearInterval(timer);
    // Re-arms on each new paste too: a row that gave up waiting must not
    // leave `waiting` stuck true and starve the next one of its polls.
  }, [waiting, pasted.length]);

  const submit = (): void => {
    if (busy || url.trim() === "") {
      return;
    }
    setBusy(true);
    setError(null);
    api.submitLink(url).then(
      (link) => {
        setUrl("");
        setPasted((current) => [link, ...current.filter((l) => l.entityId !== link.entityId)]);
        setBusy(false);
        onSubmitted();
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      },
    );
  };

  return (
    <div className="link-box">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          value={url}
          disabled={busy}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a link, hit enter"
          aria-label="Paste a link to save"
        />
      </form>
      {error !== null && <div className="link-box-error">{error}</div>}
      {pasted.map((link) => (
        <a key={link.entityId} className="pasted-link" href={`#/entity/${link.entityId}`}>
          <span className="pasted-name">{link.title ?? urlLabel(link.url)}</span>
          <span className="pasted-status">
            {link.title === null ? "reading the page…" : "saved"}
          </span>
        </a>
      ))}
    </div>
  );
}
