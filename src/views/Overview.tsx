import { useEffect, useState } from "react";
import type { OverviewPayload } from "#shared/types.ts";
import { api } from "../lib/api.ts";
import { HeatGraph } from "../components/HeatGraph.tsx";
import { BusyButton, Empty, IssueRow, Panel, Stat } from "../components/common.tsx";
import { bytes, compact, heatColor, ms, n } from "../lib/format.ts";
import { usePreferences } from "../lib/preferences.tsx";

export function Overview({ onSelectTable }: { onSelectTable: (table: string) => void }) {
  const { t: tr, locale } = usePreferences();
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  async function load() {
    setBusy(true);
    try {
      setData(await api.overview());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (error)
    return (
      <div className="view">
        <div className="error-box">{error}</div>
      </div>
    );
  if (!data)
    return (
      <div className="loading-view">
        <span className="spinner" /> {tr("readingSchema")}
      </div>
    );

  const criticals = data.issues.filter((i) => i.severity === "critical");
  // toSorted leaves `data.tables` alone; sorting it in place would reorder the
  // table listing below as a side effect of picking the hottest one.
  const hottest = data.tables.toSorted((a, b) => b.heat - a.heat)[0];

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">{data.database}</h1>
          <div className="view-sub">
            {data.totals.tableCount} {locale === "ja" ? "テーブル" : "tables"} ·{" "}
            {n(data.totals.rowCount)} {tr("rows")} ·{" "}
            {bytes(data.totals.dataBytes + data.totals.indexBytes)}
          </div>
        </div>
        <BusyButton className="btn btn-sm" onClick={() => void load()} busy={busy}>
          {tr("refresh")}
        </BusyButton>
      </div>

      {/* The headline answers the only question that matters on arrival. */}
      <div className="statbar mb">
        <Stat
          label={tr("hottestTable")}
          value={hottest?.name ?? "—"}
          color={hottest ? heatColor(hottest.heat) : undefined}
        />
        <Stat
          label={tr("criticalIssues")}
          value={String(criticals.length)}
          color={criticals.length ? "var(--crit)" : "var(--ok)"}
        />
        {/* Row counts are planner estimates, not COUNT(*): InnoDB samples index
            pages, PostgreSQL reports what the last ANALYZE saw. Two engines
            holding identical data can therefore print different totals, so the
            figure is marked approximate rather than looking like a discrepancy. */}
        <Stat
          label={tr("rows")}
          value={`~${compact(data.totals.rowCount)}`}
          title={tr("rowsApprox")}
        />
        <Stat label={tr("data")} value={bytes(data.totals.dataBytes)} />
        <Stat label={tr("index")} value={bytes(data.totals.indexBytes)} />
        <Stat
          label={tr("unindexedJoins")}
          value={String(data.relations.filter((r) => r.unindexed).length)}
          color={data.relations.some((r) => r.unindexed) ? "var(--t3)" : undefined}
        />
      </div>

      {!data.perfSchema.digestEnabled ? (
        <div className="notice mb">
          <b>{tr("queryStatsOff")}</b> {data.perfSchema.reason} Detection falls back to schema
          rules, which still finds missing indexes and full scans.
        </div>
      ) : null}

      <div className="cols">
        <HeatGraph overview={data} onSelect={onSelectTable} />

        <Panel title={tr("fixFirst")} count={criticals.length} flush scroll>
          {data.issues.length === 0 ? (
            <Empty title={tr("nothingObvious")} hint={tr("noRules")} />
          ) : (
            data.issues
              .slice(0, 40)
              .map((issue, i) => <IssueRow key={i} issue={issue} onOpenTable={onSelectTable} />)
          )}
        </Panel>
      </div>

      <div className="mt">
        <Panel title={tr("tables")} count={data.tables.length} flush>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{tr("tables")}</th>
                  <th style={{ width: 92 }}>{tr("heat")}</th>
                  <th className="num" title={tr("rowsApprox")}>
                    ~{tr("rows")}
                  </th>
                  <th className="num">{tr("data")}</th>
                  <th className="num">{tr("index")}</th>
                  <th className="num">Idx</th>
                  <th className="num">{tr("columnsShort")}</th>
                  <th className="num">{tr("queryTime")}</th>
                  <th className="num">{tr("rowsRead")}</th>
                  <th>{tr("issues")}</th>
                </tr>
              </thead>
              <tbody>
                {data.tables.map((t) => (
                  <tr
                    key={t.name}
                    onClick={() => onSelectTable(t.name)}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="strong">{t.name}</td>
                    <td>
                      {/* The bar is the comparison; the number is the detail. */}
                      <div className="row" style={{ gap: 6 }}>
                        <div
                          style={{
                            width: 44,
                            height: 4,
                            background: "var(--ink)",
                            borderRadius: 2,
                            overflow: "hidden",
                          }}
                        >
                          <div
                            style={{
                              width: `${t.heat}%`,
                              height: "100%",
                              background: heatColor(t.heat),
                            }}
                          />
                        </div>
                        <span style={{ color: heatColor(t.heat), fontSize: 11 }}>{t.heat}</span>
                      </div>
                    </td>
                    <td className="num">{n(t.rows)}</td>
                    <td className="num">{bytes(t.dataBytes)}</td>
                    <td className="num">{bytes(t.indexBytes)}</td>
                    <td
                      className="num"
                      style={
                        t.indexCount === 0 && t.rows > 10000 ? { color: "var(--crit)" } : undefined
                      }
                    >
                      {t.indexCount}
                    </td>
                    <td className="num">{t.columnCount}</td>
                    <td className="num">{t.load ? ms(t.load.totalTimeMs) : "—"}</td>
                    <td className="num">{t.load ? compact(t.load.rowsExamined) : "—"}</td>
                    <td>
                      {t.issues.length === 0 ? (
                        <span className="faint">{tr("clean")}</span>
                      ) : (
                        <span className="row" style={{ gap: 4 }}>
                          {t.issues.filter((i) => i.severity === "critical").length > 0 ? (
                            <span className="badge badge-crit">
                              {t.issues.filter((i) => i.severity === "critical").length} crit
                            </span>
                          ) : null}
                          {t.issues.filter((i) => i.severity === "warning").length > 0 ? (
                            <span className="badge badge-warn">
                              {t.issues.filter((i) => i.severity === "warning").length} warn
                            </span>
                          ) : null}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
