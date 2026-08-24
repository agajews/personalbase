import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useCached } from "../cache.js";

// Raw view of everything the database holds — the whole system is legible
// from here: the fact plane (events), derived fold tables, and the
// operational plane (jobs, runs, checkpoints, process_state).

export function TablesView({ table }: { table: string | null }) {
  return table === null ? <TableIndex /> : <TableDetail name={table} />;
}

function TableIndex() {
  const { data: list } = useCached("tables", () => api.tables());
  if (list === null) {
    return <div className="empty">loading…</div>;
  }
  return (
    <div className="entity-page">
      <div className="entity-head">
        <span className="entity-kind">database</span>
        <h1>tables</h1>
      </div>
      <section className="link-group">
        {list.tables.map((t) => (
          <a key={t.name} className="link-row" href={`#/tables/${t.name}`}>
            <span className="link-name mono">{t.name}</span>
            <span className="link-provenance">~{t.rows} rows</span>
          </a>
        ))}
      </section>
    </div>
  );
}

const pageSize = 50;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (value instanceof Date) return value.toISOString();
  const s = String(value);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

function TableDetail({ name }: { name: string }) {
  const [sort, setSort] = useState<{ column?: string; dir: "asc" | "desc" }>({ dir: "desc" });
  const [offset, setOffset] = useState(0);

  const { data: page, error } = useCached(
    `table:${name}:${sort.column ?? ""}:${sort.dir}:${offset}`,
    () => api.table(name, { sort: sort.column, dir: sort.dir, offset }),
  );

  useEffect(() => {
    setSort({ dir: "desc" });
    setOffset(0);
  }, [name]);

  if (error !== null) {
    return <div className="error">{error}</div>;
  }
  if (page === null) {
    return <div className="empty">loading…</div>;
  }
  return (
    <div className="entity-page table-page">
      <div className="entity-head">
        <span className="entity-kind">table</span>
        <h1 className="mono">{page.name}</h1>
      </div>
      <p className="run-fact">
        {page.total} rows · sorted by {page.sort} {page.dir} · click a column to sort
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {page.columns.map((col) => (
                <th
                  key={col.name}
                  title={col.type}
                  onClick={() => {
                    setOffset(0);
                    setSort({
                      column: col.name,
                      dir: sort.column === col.name && sort.dir === "desc" ? "asc" : "desc",
                    });
                  }}
                >
                  {col.name}
                  {page.sort === col.name ? (page.dir === "desc" ? " ↓" : " ↑") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row, i) => (
              <tr key={i}>
                {page.columns.map((col) => (
                  <td key={col.name} title={String(row[col.name] ?? "")}>
                    {cell(row[col.name])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="run-row">
        <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
          ← newer
        </button>
        <span className="run-fact">
          {offset + 1}–{Math.min(offset + pageSize, page.total)} of {page.total}
        </span>
        <button
          disabled={offset + pageSize >= page.total}
          onClick={() => setOffset(offset + pageSize)}
        >
          older →
        </button>
      </div>
    </div>
  );
}
