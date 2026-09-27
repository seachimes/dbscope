import { useEffect, useRef, useState } from "react";
import type { QueryStat } from "#shared/types.ts";
import { api } from "../lib/api.ts";
import { BusyButton, Empty, Panel } from "../components/common.tsx";
import { compact, heatColor, ms, n, prettySql } from "../lib/format.ts";
import { usePreferences } from "../lib/preferences.tsx";
import { localizedAdvice } from "../lib/localize.ts";

export function Queries({
  canReset,
  onExplain,
}: {
  /** MySQL has no per-database reset, so the control is PostgreSQL-only. */
  canReset: boolean;
  onExplain: (sql: string) => void;
}) {
  const { t } = usePreferences();
  const resetDialog = useRef<HTMLDialogElement>(null);
  const [queries, setQueries] = useState<QueryStat[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const res = await api.queries();
      setAvailable(res.available);
      setReason(res.reason);
      setQueries(res.queries);
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

  async function reset() {
    if (busy) return;
    setResetError(null);
    setBusy(true);
    try {
      await api.resetQueries();
      resetDialog.current?.close();
      await load();
    } catch (err) {
      setResetError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !queries)
    return (
      <div className="view">
        <div className="error-box" role="alert">
          {error}
        </div>
        <button className="btn mt" onClick={() => void load()}>
          {t("retry")}
        </button>
      </div>
    );
  if (!queries)
    return (
      <div className="loading-view" role="status">
        <span className="spinner" /> {t("readingQueries")}
      </div>
    );

  const totalTime = queries.reduce((a, q) => a + q.totalTimeMs, 0);

  return (
    <div className="view">
      <div className="view-head">
        <div>
          <h1 className="view-title">{t("queriesImpact")}</h1>
          <div className="view-sub">{t("queriesSub")}</div>
        </div>
        <div className="row">
          {canReset ? (
            <button
              className="btn btn-sm"
              disabled={busy || !available}
              onClick={() => {
                setResetError(null);
                resetDialog.current?.showModal();
              }}
            >
              {t("resetCounters")}
            </button>
          ) : null}
          <BusyButton className="btn btn-sm" onClick={() => void load()} busy={busy}>
            {t("refresh")}
          </BusyButton>
        </div>
      </div>

      <dialog
        ref={resetDialog}
        className="reset-dialog"
        aria-labelledby="reset-dialog-title"
        aria-describedby="reset-dialog-detail"
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <h2 id="reset-dialog-title">{t("resetConfirmTitle")}</h2>
        <p id="reset-dialog-detail">{t("resetScopePostgres")}</p>
        <p className="reset-dialog-note">{t("resetConfirmDetail")}</p>
        {resetError && (
          <div className="error-box" role="alert">
            {resetError}
          </div>
        )}
        <div className="reset-dialog-actions">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => resetDialog.current?.close()}
          >
            {t("cancel")}
          </button>
          <BusyButton
            type="button"
            className="btn btn-danger"
            busy={busy}
            onClick={() => void reset()}
          >
            {t("resetCounters")}
          </BusyButton>
        </div>
      </dialog>

      {error && (
        <div className="error-box mb" role="alert">
          {error}
        </div>
      )}

      {!available ? (
        <div className="notice mb">
          <b>{t("perfUnavailable")}</b> {reason}
        </div>
      ) : null}

      {queries.length === 0 ? (
        <Empty title={t("noQueries")} hint={t("runBenchmark")} />
      ) : (
        <>
          <div className="statbar mb">
            <div className="stat">
              <div className="stat-label">{t("distinctQueries")}</div>
              <div className="stat-value">{queries.length}</div>
            </div>
            <div className="stat">
              <div className="stat-label">{t("totalTime")}</div>
              <div className="stat-value">{ms(totalTime)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">{t("topShare")}</div>
              <div className="stat-value" style={{ color: heatColor(queries[0]?.impact ?? 0) }}>
                {queries[0]?.impact ?? 0}
                <span className="stat-unit">%</span>
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">{t("withoutIndex")}</div>
              <div className="stat-value" style={{ color: "var(--t3)" }}>
                {queries.filter((q) => q.noIndexUsed > 0).length}
              </div>
            </div>
          </div>
          <QueryList queries={queries} onExplain={onExplain} />
        </>
      )}
    </div>
  );
}

export function QueryList({
  queries,
  onExplain,
}: {
  queries: QueryStat[];
  onExplain: (sql: string) => void;
}) {
  const { t, locale } = usePreferences();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Panel title={t("rankedQueries")} count={queries.length} flush>
      {queries.map((q) => {
        const isOpen = open === q.digest;
        return (
          <div
            key={q.digest}
            className="qrow"
            aria-selected={isOpen}
            onClick={() => setOpen(isOpen ? null : q.digest)}
          >
            <div className="qrow-top">
              <span className="impact-pct" style={{ color: heatColor(q.impact * 2.2) }}>
                {q.impact}%
              </span>
              <span className="impact-bar">
                <span
                  className="impact-fill"
                  style={{
                    width: `${Math.min(100, q.impact)}%`,
                    background: heatColor(q.impact * 2.2),
                  }}
                />
              </span>
            </div>

            <div className="qsql">{q.digestText}</div>

            <div className="qmeta">
              <span>
                <b>{ms(q.totalTimeMs)}</b> total
              </span>
              <span>
                <b>{ms(q.avgTimeMs)}</b> avg
              </span>
              <span>
                <b>{n(q.execCount)}</b> calls
              </span>
              <span>
                <b>{compact(q.rowsExamined)}</b> rows read
              </span>
              {q.examinedPerSent >= 10 ? (
                <span className="hot">
                  <b>{Math.round(q.examinedPerSent)}×</b> {t("readPerReturned")}
                </span>
              ) : null}
              {q.tables.length > 0 ? <span className="faint">{q.tables.join(", ")}</span> : null}
            </div>

            {q.advice.length > 0 ? (
              <div className="advice-preview">
                {q.advice.slice(0, 2).map((raw, i) => {
                  const advice = localizedAdvice(raw, locale);
                  return (
                    <span key={i} className={`advice-pill advice-${advice.kind}`}>
                      <b>{advice.kind === "batch" ? "N+1?" : advice.kind.toUpperCase()}</b>{" "}
                      {advice.title}
                    </span>
                  );
                })}
              </div>
            ) : null}

            {q.issues.length > 0 ? (
              <div className="qbadges">
                {q.issues.map((issue, i) => (
                  <span
                    key={i}
                    className={`badge badge-${issue.severity === "critical" ? "crit" : "warn"}`}
                    title={issue.detail}
                  >
                    {issue.code.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            ) : null}

            {isOpen ? (
              <div className="mt" onClick={(e) => e.stopPropagation()}>
                <pre className="raw">{prettySql(q.digestText)}</pre>
                {q.advice.length > 0 ? (
                  <div className="advice-list">
                    {q.advice.map((raw, i) => {
                      const advice = localizedAdvice(raw, locale);
                      return (
                        <div key={i} className={`advice-card advice-${advice.kind}`}>
                          <div className="advice-head">
                            <span>
                              {advice.kind === "batch" ? "N+1 / BATCH" : advice.kind.toUpperCase()}
                            </span>
                            <span>{advice.confidence.toUpperCase()} CONFIDENCE</span>
                          </div>
                          <b>{advice.title}</b>
                          <p>{advice.detail}</p>
                          {advice.example ? <code>{advice.example}</code> : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                <div className="btn-row">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => onExplain(q.digestText)}
                  >
                    {t("sendExplain")}
                  </button>
                  <span className="faint small">{t("replacePlaceholder")}</span>
                </div>
                {q.issues.map((issue, i) => (
                  <div key={i} className="notice mt">
                    <b>{issue.title}.</b> {issue.detail}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </Panel>
  );
}
