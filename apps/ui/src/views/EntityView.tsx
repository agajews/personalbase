import { useState } from "react";
import { api, type EntityLink, type EntityTagGroup } from "../api.js";
import { useCached } from "../cache.js";
import { Abstract, ago, EntityChip, facetHue, MarkButtons, TagChips } from "../ui.js";

// One generic page for any entity: identity, kind-specific detail, and the
// graph around it — every neighbor is a link to its own page.

const linkTypeLabels: Record<string, { out: string; in: string }> = {
  authored: { out: "wrote", in: "authors" },
  affiliated_with: { out: "affiliated with", in: "affiliated people" },
  affiliated_org: { out: "author affiliations", in: "papers with affiliated authors" },
  published_by: { out: "published by", in: "publications" },
};

function LinkGroup({
  title,
  links,
}: {
  title: string;
  links: EntityLink[];
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? links : links.slice(0, 12);
  return (
    <section className="link-group">
      <div className="feed-date">
        {title} ({links.length})
      </div>
      {shown.map((l) => (
        <a
          key={`${l.other.entityId}-${l.assertedBy}`}
          className="link-row"
          href={`#/entity/${l.other.entityId}`}
        >
          <span className="link-kind">{l.other.kind}</span>
          <span className="link-name">{l.other.displayName ?? l.other.entityId}</span>
          <span className="link-provenance">
            {l.assertedBy}
            {l.confidence < 1 ? ` · ${l.confidence.toFixed(2)}` : ""}
          </span>
        </a>
      ))}
      {links.length > shown.length && (
        <button className="ghost" onClick={() => setExpanded(true)}>
          show all {links.length}
        </button>
      )}
    </section>
  );
}

function groupLinks(links: EntityLink[], direction: "out" | "in"): [string, EntityLink[]][] {
  const groups = new Map<string, EntityLink[]>();
  for (const link of links) {
    const label = linkTypeLabels[link.linkType]?.[direction] ?? `${link.linkType} (${direction})`;
    const group = groups.get(label) ?? [];
    group.push(link);
    groups.set(label, group);
  }
  return [...groups.entries()];
}

/**
 * What the papers around an entity are about. On an affiliation this reads as
 * the lab's subject matter; on a person, theirs — the same papers the link
 * groups below list flat, organized by the tags they carry instead.
 */
function TagGroups({ groups }: { groups: EntityTagGroup[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? groups : groups.slice(0, 8);
  return (
    <section className="tag-groups">
      <div className="feed-date">what these papers are about ({groups.length} tags)</div>
      {shown.map((g) => (
        <TagGroup key={g.slug} group={g} />
      ))}
      {groups.length > shown.length && (
        <button className="ghost" onClick={() => setExpanded(true)}>
          show all {groups.length} tags
        </button>
      )}
    </section>
  );
}

function TagGroup({ group }: { group: EntityTagGroup }) {
  const [expanded, setExpanded] = useState(false);
  const papers = expanded ? group.papers : group.papers.slice(0, 4);
  const h = facetHue(group.facet);
  return (
    <div className="tag-group">
      <a
        className="tag-chip tag-group-name"
        href={`#/tag/${encodeURIComponent(group.slug)}`}
        style={{
          color: `hsl(${h} 40% 32%)`,
          background: `hsl(${h} 44% 96%)`,
          borderColor: `hsl(${h} 32% 84%)`,
        }}
      >
        {group.name} <span className="mono">{group.papers.length}</span>
      </a>
      <div className="tag-group-papers">
        {papers.map((p) => (
          <a key={p.entityId} className="tag-group-paper" href={`#/entity/${p.entityId}`}>
            {p.title ?? p.entityId}
          </a>
        ))}
        {group.papers.length > papers.length && (
          <button className="linky" onClick={() => setExpanded(true)}>
            + {group.papers.length - papers.length} more
          </button>
        )}
      </div>
    </div>
  );
}

export function EntityView({ id }: { id: string }) {
  const { data: page, error, refresh } = useCached(`entity:${id}`, () => api.entity(id));

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (page === null) {
    return <div className="empty">loading…</div>;
  }

  const { entity, paper, library, verdicts } = page;
  const dedupedLinks = (links: typeof page.linksOut) => {
    const seen = new Set<string>();
    return links.filter((l) => {
      const key = `${l.linkType}|${l.other.entityId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  // A paper's affiliations are context you want before the abstract, not a
  // link group at the foot of the page — they ride up top as one serif row.
  const linksOut = dedupedLinks(page.linksOut);
  const affiliations = linksOut.filter((l) => l.linkType === "affiliated_org");
  const otherLinksOut = linksOut.filter((l) => l.linkType !== "affiliated_org");
  // The paper card headlines the arXiv id already — don't print it twice.
  const identifiers = page.identifiers.filter(
    (i) => paper === null || i.scheme !== "arxiv_id",
  );

  return (
    <div className="entity-page">
      <div className="entity-head">
        {/* A paper announces itself — the kind label only earns its place on
            entities whose type isn't obvious from the page below. */}
        {entity.kind !== "paper" && <span className="entity-kind">{entity.kind}</span>}
        <h1>{entity.displayName ?? entity.entityId}</h1>
        {(entity.kind === "paper" || entity.kind === "resource") && (
          <MarkButtons entityId={entity.entityId} mark={page.mark} onChanged={refresh} />
        )}
      </div>
      {affiliations.length > 0 && (
        <p className="entity-affiliations">
          {affiliations.map((l) => (
            <EntityChip
              key={l.other.entityId}
              entityId={l.other.entityId}
              name={l.other.displayName ?? l.other.entityId}
              className="affiliation-link"
            />
          ))}
        </p>
      )}
      <TagChips tags={page.tags} />
      {identifiers.length > 0 && (
        <p className="entity-idents">
          {identifiers.map((i) => (
            <span key={`${i.scheme}:${i.value}`} className="ident">
              {i.scheme}: {i.value}
            </span>
          ))}
        </p>
      )}

      {paper !== null && (
        <section className="entity-detail">
          <a
            className="paper-link"
            href={`https://arxiv.org/abs/${paper.arxiv_id}`}
            target="_blank"
            rel="noreferrer"
          >
            arxiv.org/abs/{paper.arxiv_id}v{paper.arxiv_version} ↗
          </a>
          <p className="verdict-authors">
            {(paper.authors as string[]).join(", ")} · {paper.categories.join(", ")}
          </p>
          <Abstract text={paper.abstract} />
          <p className="run-fact">
            published {new Date(paper.published_at).toISOString().slice(0, 10)} · ingested{" "}
            {ago(paper.ingested_at)}
          </p>
        </section>
      )}

      {library !== null && (
        <section className="entity-detail">
          <div className="feed-date">in your library</div>
          <p className="run-fact">
            added {new Date(library.added_at).toISOString().slice(0, 10)}
            {library.year !== null ? ` · ${library.year}` : ""}
            {library.journal !== null ? ` · ${library.journal}` : ""}
            {library.folders !== null && library.folders.length > 0
              ? ` · folders: ${library.folders.join(", ")}`
              : ""}
            {library.url !== null && (
              <>
                {" · "}
                <a className="arxiv-id" href={library.url} target="_blank" rel="noreferrer">
                  source
                </a>
              </>
            )}
          </p>
        </section>
      )}

      {verdicts.length > 0 && (
        <section className="entity-detail">
          <div className="feed-date">filter verdicts</div>
          {verdicts.map((v) => (
            <p key={`${v.filter_name}-${v.current}`} className="run-fact">
              {v.filter_name}: {v.verdict} ({Number(v.confidence).toFixed(2)})
              {v.current ? "" : " — earlier prompt"} — {v.reason}
            </p>
          ))}
        </section>
      )}

      {page.tagGroups.length > 0 && <TagGroups groups={page.tagGroups} />}

      {groupLinks(otherLinksOut, "out").map(([label, links]) => (
        <LinkGroup key={`out-${label}`} title={label} links={links} />
      ))}
      {groupLinks(dedupedLinks(page.linksIn), "in").map(([label, links]) => (
        <LinkGroup key={`in-${label}`} title={label} links={links} />
      ))}
    </div>
  );
}
