import { useEffect, useState } from "react";
import type { DataFilter, DataPage, FilterOperator, TableDetailPayload } from "#shared/types.ts";
import { api } from "../lib/api.ts";
import { BusyButton, Empty, IssueRow, Panel, Stat } from "../components/common.tsx";
import { bytes, cell, compact, heatColor, ms, n } from "../lib/format.ts";
import { QueryList } from "./Queries.tsx";
import { usePreferences } from "../lib/preferences.tsx";

type Tab = "data" | "schema" | "indexes" | "queries";

export function TableDetail({
  table,
  onExplain,
}: {
  table: string;
  onExplain: (sql: string) => void;
}) {
  const { t } = usePreferences();
  const [detail, setDetail] = useState<TableDetailPayload | null>(null);
  const [tab, setTab] = useState<Tab>("data");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setDetail(await api.table(table));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    setDetail(null);
    void load();
  }, [table]);

  if (error)
    return (
      <div className="view">
        <div className="error-box">{error}</div>
      </div>
    );
  if (!detail)
    return (
      <div className="loading-view">
        <span className="spinner" /> Loading {table}…
      </div>
    );

  const s = detail.summary;

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">{detail.name}</h1>
          <div className="view-sub">
            {s.engine} · {s.columnCount} columns · {s.indexCount} secondary index
            {s.indexCount === 1 ? "" : "es"}
          </div>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => onExplain(`SELECT * FROM ${detail.name} LIMIT 20`)}
        >
          {t("explainHere")}
        </button>
      </div>

      <div className="statbar mb">
        <Stat label={t("heat")} value={String(s.heat)} color={heatColor(s.heat)} />
        <Stat label={t("rows")} value={n(s.rows)} />
        <Stat label={t("data")} value={bytes(s.dataBytes)} />
        <Stat label={t("index")} value={bytes(s.indexBytes)} />
        <Stat label={t("queryTime")} value={s.load ? ms(s.load.totalTimeMs) : "—"} />
        <Stat
          label={t("rowsRead")}
          value={s.load ? compact(s.load.rowsExamined) : "—"}
          color={s.load && s.load.rowsExamined > 1e6 ? "var(--t3)" : undefined}
        />
      </div>

      {detail.issues.length > 0 ? (
        <div className="mb">
          <Panel title={t("issues")} count={detail.issues.length} flush>
            {detail.issues.map((issue, i) => (
              <IssueRow key={i} issue={issue} />
            ))}
          </Panel>
        </div>
      ) : null}

      <div className="tabs" role="tablist">
        {(["data", "schema", "indexes", "queries"] as Tab[]).map((tabKey) => (
          <button
            key={tabKey}
            className="tab"
            role="tab"
            aria-selected={tab === tabKey}
            onClick={() => setTab(tabKey)}
          >
            {
              (
                {
                  data: t("data"),
                  schema: t("schema"),
                  indexes: t("indexes"),
                  queries: t("tableQueries"),
                } as const
              )[tabKey]
            }
            {tabKey === "queries" && detail.queries.length > 0 ? ` (${detail.queries.length})` : ""}
          </button>
        ))}
      </div>

      {tab === "data" ? <DataTab table={detail.name} /> : null}
      {tab === "schema" ? <SchemaTab detail={detail} /> : null}
      {tab === "indexes" ? <IndexTab detail={detail} onChanged={load} /> : null}
      {tab === "queries" ? (
        detail.queries.length === 0 ? (
          <Empty
            title={t("noTableQueries")}
            hint="Either query statistics are unavailable, or nothing has queried this table since the last reset."
          />
        ) : (
          <QueryList queries={detail.queries} onExplain={onExplain} />
        )
      ) : null}
    </div>
  );
}

function DataTab({ table }: { table: string }) {
  const { t } = usePreferences();
  const [page, setPage] = useState<DataPage | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [filterColumn, setFilterColumn] = useState("");
  const [filterOperator, setFilterOperator] = useState<FilterOperator>("eq");
  const [filterValue, setFilterValue] = useState("");
  const [applied, setApplied] = useState<DataFilter | null>(null);
  const [sort, setSort] = useState<{ by: string | null; dir: "asc" | "desc" }>({
    by: null,
    dir: "asc",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    api
      .tableData(table, {
        page: pageNo,
        pageSize: 50,
        orderBy: sort.by,
        orderDir: sort.dir,
        filter: applied,
      })
      .then((res) => {
        if (cancelled) return;
        setPage(res);
        setError(null);
      })
      .catch((err) => !cancelled && setError((err as Error).message))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [table, pageNo, sort, applied]);

  const lastPage = page ? Math.max(1, Math.ceil(page.estimatedTotal / page.pageSize)) : 1;

  return (
    <Panel
      title={t("rowsPanel")}
      count={page ? `~${n(page.estimatedTotal)}` : "…"}
      flush
      actions={page ? <span className="faint small mono">{ms(page.elapsedMs)}</span> : null}
    >
      <div className="panel-body" style={{ paddingBottom: 0 }}>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (!filterColumn) return;
            setPageNo(1);
            setApplied({
              column: filterColumn,
              operator: filterOperator,
              ...(!["is_null", "is_not_null"].includes(filterOperator)
                ? { value: filterValue }
                : {}),
            });
          }}
        >
          <select
            className="inline-input"
            aria-label="Filter column"
            value={filterColumn}
            onChange={(e) => setFilterColumn(e.target.value)}
          >
            <option value="">{t("column")}…</option>
            {page?.columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
          <select
            className="inline-input"
            aria-label="Filter operator"
            value={filterOperator}
            onChange={(e) => setFilterOperator(e.target.value as FilterOperator)}
          >
            <option value="eq">=</option>
            <option value="ne">≠</option>
            <option value="gt">&gt;</option>
            <option value="gte">≥</option>
            <option value="lt">&lt;</option>
            <option value="lte">≤</option>
            <option value="contains">contains</option>
            <option value="starts_with">starts with</option>
            <option value="is_null">is NULL</option>
            <option value="is_not_null">is not NULL</option>
          </select>
          {!["is_null", "is_not_null"].includes(filterOperator) ? (
            <input
              className="inline-input grow"
              aria-label="Filter value"
              placeholder={t("value")}
              value={filterValue}
              onChange={(e) => setFilterValue(e.target.value)}
            />
          ) : null}
          <button className="btn btn-sm" type="submit" disabled={!filterColumn}>
            Filter
          </button>
          {applied ? (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => {
                setFilterValue("");
                setApplied(null);
                setPageNo(1);
              }}
            >
              Clear
            </button>
          ) : null}
        </form>
      </div>

      {error ? (
        <div className="panel-body">
          <div className="error-box">{error}</div>
        </div>
      ) : null}

      <div className="tbl-scroll" style={{ marginTop: 12 }}>
        <table className="tbl">
          <thead>
            <tr>
              {page?.columns.map((col) => (
                <th
                  key={col}
                  className="sortable"
                  onClick={() =>
                    setSort((s) => ({
                      by: col,
                      dir: s.by === col && s.dir === "asc" ? "desc" : "asc",
                    }))
                  }
                >
                  {col}
                  {sort.by === col ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page?.rows.map((row, i) => (
              <tr key={i}>
                {page.columns.map((col) => {
                  const { text, isNull } = cell(row[col]);
                  return (
                    <td key={col} className={isNull ? "null" : undefined} title={text}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel-body row">
        <button
          className="btn btn-sm"
          disabled={pageNo <= 1 || busy}
          onClick={() => setPageNo((p) => Math.max(1, p - 1))}
        >
          ← Prev
        </button>
        <span className="faint small mono">
          page {pageNo} of ~{n(lastPage)}
        </span>
        <button
          className="btn btn-sm"
          disabled={busy || (page ? page.rows.length < page.pageSize : true)}
          onClick={() => setPageNo((p) => p + 1)}
        >
          Next →
        </button>
        {busy ? <span className="spinner" /> : null}
      </div>
    </Panel>
  );
}

function SchemaTab({ detail }: { detail: TableDetailPayload }) {
  const { t } = usePreferences();
  return (
    <div className="cols-wide">
      <Panel title={t("columns")} count={detail.columns.length} flush>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("column")}</th>
                <th>{t("type")}</th>
                <th>{t("nullable")}</th>
                <th>{t("key")}</th>
                <th>{t("default")}</th>
                <th>{t("extra")}</th>
              </tr>
            </thead>
            <tbody>
              {detail.columns.map((col) => (
                <tr key={col.name}>
                  <td className="strong">{col.name}</td>
                  <td>{col.columnType}</td>
                  <td>{col.nullable ? "YES" : "NO"}</td>
                  <td style={col.key === "PRI" ? { color: "var(--t0)" } : undefined}>
                    {col.key || "—"}
                  </td>
                  <td className={col.defaultValue === null ? "null" : undefined}>
                    {col.defaultValue ?? "NULL"}
                  </td>
                  <td>{col.extra || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <div>
        <Panel title={t("relations")} count={detail.relations.length} flush>
          {detail.relations.length === 0 ? (
            <Empty title={t("noRelations")} />
          ) : (
            <div className="tbl-scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("from")}</th>
                    <th>{t("to")}</th>
                    <th>{t("source")}</th>
                    <th>Index</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.relations.map((rel, i) => (
                    <tr key={i}>
                      <td className="strong">
                        {rel.fromTable}.{rel.fromColumn}
                      </td>
                      <td>
                        {rel.toTable}.{rel.toColumn}
                      </td>
                      <td>
                        {rel.kind === "foreign_key" ? (
                          "FOREIGN KEY"
                        ) : (
                          <span title={`confidence ${Math.round(rel.confidence * 100)}%`}>
                            inferred
                          </span>
                        )}
                      </td>
                      <td className={rel.unindexed ? "crit-text" : "ok-text"}>
                        {rel.unindexed ? "MISSING" : "ok"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="mt">
          <Panel title="SHOW CREATE TABLE">
            <pre className="raw">{detail.createStatement}</pre>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function IndexTab({ detail, onChanged }: { detail: TableDetailPayload; onChanged: () => void }) {
  const { t } = usePreferences();
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [unique, setUnique] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (col: string) =>
    setSelected((s) => (s.includes(col) ? s.filter((c) => c !== col) : [...s, col]));

  async function create() {
    if (!window.confirm(t("createConfirm", { table: detail.name, columns: selected.join(", ") })))
      return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.createIndex({
        table: detail.name,
        columns: selected,
        name: name.trim() || undefined,
        unique,
      });
      setMessage(res.message);
      setSelected([]);
      setName("");
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function drop(indexName: string) {
    if (!window.confirm(t("dropConfirm", { index: indexName, table: detail.name }))) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const res = await api.dropIndex(detail.name, indexName);
      setMessage(res.message);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const preview =
    selected.length > 0
      ? `ALTER TABLE \`${detail.name}\` ADD ${unique ? "UNIQUE " : ""}INDEX \`${
          name.trim() || `idx_${selected.join("_")}`
        }\` (${selected.map((c) => `\`${c}\``).join(", ")});`
      : null;

  return (
    <div className="cols-wide">
      <Panel title={t("currentIndexes")} count={detail.indexes.length} flush>
        <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>{t("name")}</th>
                <th>{t("columns")}</th>
                <th>{t("unique")}</th>
                <th className="num">{t("cardinality")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {detail.indexes.map((idx) => (
                <tr key={idx.name}>
                  <td className="strong">
                    {idx.name}
                    {idx.valid === false && (
                      <span className="pill pill-warn" title={t("invalidIndexHint")}>
                        {t("invalidIndex")}
                      </span>
                    )}
                  </td>
                  {/* Defensive: a driver that fails to decode an array column must
                      degrade to readable text, never crash the whole view. */}
                  <td>
                    {Array.isArray(idx.columns)
                      ? idx.columns.join(", ")
                      : String(idx.columns ?? "")}
                  </td>
                  <td>{idx.unique ? "YES" : "no"}</td>
                  <td className="num">{idx.cardinality === null ? "—" : n(idx.cardinality)}</td>
                  <td>
                    {idx.isPrimary ? (
                      <span className="faint small">{t("primary")}</span>
                    ) : (
                      <button
                        className="btn btn-sm btn-danger"
                        disabled={busy}
                        onClick={() => void drop(idx.name)}
                      >
                        Drop
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title={t("addIndex")}>
        <div className="field">
          <label>{t("selectColumns")}</label>
          <div className="col-pick">
            {detail.columns.map((col) => {
              const rank = selected.indexOf(col.name);
              return (
                <button
                  key={col.name}
                  className="col-chip"
                  aria-pressed={rank >= 0}
                  onClick={() => toggle(col.name)}
                  type="button"
                >
                  {col.name}
                  {rank >= 0 ? <span className="col-order">{rank + 1}</span> : null}
                </button>
              );
            })}
          </div>
          <span className="field-hint">
            Order matters: put equality columns first, then the one you sort by.
          </span>
        </div>

        <div className="grid-2 mt">
          <div className="field">
            <label htmlFor="idxname">Name</label>
            <input
              id="idxname"
              className="inline-input"
              value={name}
              placeholder={selected.length ? `idx_${selected.join("_")}` : "idx_…"}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <label className="toggle-row" style={{ alignSelf: "end", paddingBottom: 8 }}>
            <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
            Unique
          </label>
        </div>

        {preview ? <pre className="raw mt">{preview}</pre> : null}

        <div className="btn-row">
          <BusyButton
            className="btn btn-primary"
            busy={busy}
            disabled={selected.length === 0}
            onClick={() => void create()}
          >
            {t("createIndex")}
          </BusyButton>
          {selected.length > 0 ? (
            <button className="btn btn-sm" onClick={() => setSelected([])}>
              Clear
            </button>
          ) : null}
        </div>

        {message ? (
          <div className="notice mt" style={{ borderLeftColor: "var(--ok)" }}>
            {message}
          </div>
        ) : null}
        {error ? <div className="error-box">{error}</div> : null}
      </Panel>
    </div>
  );
}
