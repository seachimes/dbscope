import { useEffect, useState } from "react";
import type { BeforeAfter, ExplainPayload, SessionInfo } from "#shared/types.ts";
import { api } from "../lib/api.ts";
import { PlanFlow } from "../components/PlanFlow.tsx";
import { BusyButton, DdlBlock, Empty, IssueRow, Panel } from "../components/common.tsx";
import { ms, n } from "../lib/format.ts";
import { usePreferences } from "../lib/preferences.tsx";
import { localizedAdvice } from "../lib/localize.ts";

export function Explain({ session, initialSql }: { session: SessionInfo; initialSql: string }) {
  const { t, locale } = usePreferences();
  const [sql, setSql] = useState(initialSql);
  const [plan, setPlan] = useState<ExplainPayload | null>(null);
  const [comparison, setComparison] = useState<BeforeAfter | null>(null);
  const [analyze, setAnalyze] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  // A query arriving from another view should explain itself immediately —
  // the click already expressed the intent.
  useEffect(() => {
    setSql(initialSql);
    if (initialSql.trim() && !/\?/.test(initialSql)) void run(initialSql);
  }, [initialSql]);

  async function run(statement = sql) {
    if (!statement.trim()) return;
    setBusy(true);
    setError(null);
    setComparison(null);
    try {
      setPlan(await api.explain(statement, analyze));
    } catch (err) {
      setError((err as Error).message);
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }

  async function applyAndCompare(table: string, columns: string[]) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.applyAndCompare(sql, { table, columns });
      setComparison(result);
      setPlan(result.after);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hasPlaceholder = /\?/.test(sql);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">EXPLAIN</h1>
          <div className="view-sub">{t("explainSub")}</div>
        </div>
      </div>

      <Panel
        title={t("sql")}
        actions={
          <div className="row">
            <label
              className="toggle-row small"
              title={
                session.supportsExplainAnalyze
                  ? "Actually runs the query and reports measured timings"
                  : `Requires MySQL 8.0.18+ (this server is ${session.mysqlVersion})`
              }
            >
              <input
                type="checkbox"
                checked={analyze}
                disabled={!session.supportsExplainAnalyze}
                onChange={(e) => setAnalyze(e.target.checked)}
              />
              {t("analyze")}
            </label>
          </div>
        }
      >
        <textarea
          className="sql-editor"
          value={sql}
          spellCheck={false}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          placeholder="SELECT id, user_id FROM posts WHERE user_id = 42 ORDER BY created_at DESC LIMIT 20"
        />

        {hasPlaceholder ? <div className="notice mt">{t("replacePlaceholder")}</div> : null}

        <div className="btn-row">
          <BusyButton className="btn btn-primary" onClick={() => void run()} busy={busy}>
            {t("runExplain")}
          </BusyButton>
          <span className="faint small mono">⌘/Ctrl + Enter</span>
          <span className="spacer" />
          {analyze && !session.supportsExplainAnalyze ? (
            <span className="faint small">ANALYZE needs MySQL 8.0.18+</span>
          ) : null}
        </div>

        {error ? <div className="error-box">{error}</div> : null}
      </Panel>

      {comparison ? <Verdict comparison={comparison} /> : null}

      {plan ? (
        <div className="cols mt">
          <Panel
            title={t("plan")}
            actions={
              <span className="faint small mono">
                ~{n(plan.estimatedCost)} rows · {ms(plan.elapsedMs)}
              </span>
            }
            flush
          >
            <PlanFlow steps={plan.steps} />
          </Panel>

          <div>
            <Panel title={t("problems")} count={plan.issues.length} flush>
              {plan.issues.length === 0 ? (
                <Empty title={t("nothingFlagged")} hint={t("planHealthy")} />
              ) : (
                plan.issues.map((issue, i) => <IssueRow key={i} issue={issue} />)
              )}
            </Panel>

            {plan.advice.length > 0 ? (
              <div className="mt">
                <Panel
                  title={locale === "ja" ? "先に検討する改善" : "Improve the query first"}
                  count={plan.advice.length}
                >
                  <div className="advice-list">
                    {plan.advice.map((raw, i) => {
                      const advice = localizedAdvice(raw, locale);
                      return (
                        <div key={i} className={`advice-card advice-${advice.kind}`}>
                          <div className="advice-head">
                            <span>{advice.kind.toUpperCase()}</span>
                            <span>{advice.confidence.toUpperCase()} CONFIDENCE</span>
                          </div>
                          <b>{advice.title}</b>
                          <p>{advice.detail}</p>
                          {advice.example ? <code>{advice.example}</code> : null}
                        </div>
                      );
                    })}
                  </div>
                </Panel>
              </div>
            ) : null}

            {plan.suggestions.length > 0 ? (
              <div className="mt">
                <Panel title={t("tryIndex")} count={plan.suggestions.length}>
                  {plan.suggestions.map((s, i) => (
                    <div key={i} style={{ marginBottom: 14 }}>
                      <div className="index-confidence">
                        <span className={`confidence confidence-${s.confidence}`}>
                          {s.confidence.toUpperCase()}
                        </span>
                        <span className="small dim">{s.reason}</span>
                      </div>
                      <DdlBlock ddl={s.ddl} />
                      <ul className="tradeoffs">
                        {s.tradeoffs.map((tradeoff, j) => (
                          <li key={j}>{tradeoff}</li>
                        ))}
                      </ul>
                      <div className="btn-row">
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={busy || s.redundant}
                          onClick={() => void applyAndCompare(s.table, s.columns)}
                          title={
                            s.redundant
                              ? "An existing index already covers these columns"
                              : "Creates the index, re-explains, and shows the difference"
                          }
                        >
                          Create and compare
                        </button>
                        {s.redundant ? (
                          <span className="faint small">{t("alreadyCovered")}</span>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </Panel>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {plan ? (
        <div className="mt">
          <Panel
            title={t("rawOutput")}
            actions={
              <button className="btn btn-sm" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? t("hide") : t("show")}
              </button>
            }
            flush={showRaw}
          >
            {showRaw ? (
              <>
                <div className="tbl-scroll">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>id</th>
                        <th>select_type</th>
                        <th>table</th>
                        <th>type</th>
                        <th>possible_keys</th>
                        <th>key</th>
                        <th>key_len</th>
                        <th>ref</th>
                        <th className="num">rows</th>
                        <th className="num">filtered</th>
                        <th>Extra</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.rows.map((r, i) => (
                        <tr key={i}>
                          <td>{r.id}</td>
                          <td>{r.selectType}</td>
                          <td className="strong">{r.table ?? "—"}</td>
                          <td className={r.type === "ALL" ? "crit-text" : undefined}>
                            {r.type ?? "—"}
                          </td>
                          <td>{r.possibleKeys ?? "—"}</td>
                          <td className={r.key === null ? "crit-text" : "ok-text"}>
                            {r.key ?? "NULL"}
                          </td>
                          <td>{r.keyLen ?? "—"}</td>
                          <td>{r.ref ?? "—"}</td>
                          <td className="num">{r.rows === null ? "—" : n(r.rows)}</td>
                          <td className="num">{r.filtered === null ? "—" : `${r.filtered}%`}</td>
                          <td>{r.extra ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {plan.analyze ? (
                  <div className="panel-body">
                    <div className="rail-label">EXPLAIN ANALYZE</div>
                    <pre className="raw">{plan.analyze}</pre>
                  </div>
                ) : null}
              </>
            ) : (
              <span className="faint small">
                The EXPLAIN table{plan.analyze ? " and ANALYZE timings" : ""}, unmodified.
              </span>
            )}
          </Panel>
        </div>
      ) : null}

      {!plan && !busy ? (
        <div className="mt">
          <Empty
            title={t("nothingExplained")}
            hint="Paste a query above, or send one over from the Queries view."
          />
        </div>
      ) : null}
    </div>
  );
}

function Verdict({ comparison }: { comparison: BeforeAfter }) {
  const { t } = usePreferences();
  const { verdict } = comparison;
  const improved = verdict.rowsAfter < verdict.rowsBefore;
  const same = verdict.rowsAfter === verdict.rowsBefore;
  const factor =
    verdict.rowsAfter > 0
      ? Math.round((verdict.rowsBefore / verdict.rowsAfter) * 10) / 10
      : verdict.rowsBefore;

  return (
    <div className={`verdict mt ${improved ? "" : same ? "verdict-flat" : "verdict-bad"}`}>
      <div className="row wrap" style={{ alignItems: "baseline", gap: 14 }}>
        <span
          className="verdict-headline"
          style={{ color: improved ? "var(--ok)" : same ? "var(--warn)" : "var(--crit)" }}
        >
          {improved ? t("fewerRows", { factor }) : same ? t("noChange") : t("worse")}
        </span>
        <span className="mono dim">
          {n(verdict.rowsBefore)} → {n(verdict.rowsAfter)}
        </span>
      </div>

      <div className="verdict-sum">{verdict.summary}</div>

      {verdict.resolved.length > 0 || verdict.introduced.length > 0 ? (
        <div className="verdict-codes">
          {verdict.resolved.map((code) => (
            <span key={code} className="chip">
              fixed: {code.replace(/_/g, " ").toLowerCase()}
            </span>
          ))}
          {verdict.introduced.map((code) => (
            <span key={code} className="chip chip-bad">
              new: {code.replace(/_/g, " ").toLowerCase()}
            </span>
          ))}
        </div>
      ) : null}

      <DdlBlock className="mt" ddl={comparison.ddl} />

      <div className="cols-wide mt">
        <Panel title={t("before")} flush>
          <PlanFlow steps={comparison.before.steps} />
        </Panel>
        <Panel title={t("after")} flush>
          <PlanFlow steps={comparison.after.steps} />
        </Panel>
      </div>
    </div>
  );
}
