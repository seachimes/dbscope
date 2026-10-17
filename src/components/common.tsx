import { useRef, useState, type ButtonHTMLAttributes, type RefObject } from "react";
import type { Issue, Severity } from "#shared/types.ts";
import { usePreferences } from "../lib/preferences.tsx";
import { localizedIssue } from "../lib/localize.ts";

export function Stat({
  label,
  value,
  unit,
  color,
  /** Explains a qualified figure, such as why a row count is approximate. */
  title,
}: {
  label: string;
  value: string;
  unit?: string | undefined;
  color?: string | undefined;
  title?: string | undefined;
}) {
  return (
    <div className="stat" title={title}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : undefined}>
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </div>
    </div>
  );
}

export function SeverityTag({ severity }: { severity: Severity }) {
  return <span className={`sev-tag sev-${severity}`}>{severity}</span>;
}

export function IssueRow({
  issue,
  onOpenTable,
}: {
  issue: Issue;
  onOpenTable?: (table: string) => void;
}) {
  const { t, locale } = usePreferences();
  const displayIssue = localizedIssue(issue, locale);
  return (
    <div className={`issue issue-${issue.severity}`}>
      <span className="issue-bar" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 7 }}>
          <SeverityTag severity={issue.severity} />
          <span className="issue-title">{displayIssue.title}</span>
        </div>
        <div className="issue-detail">{displayIssue.detail}</div>
        {issue.suggestion ? (
          <DdlBlock className="issue-ddl" ddl={issue.suggestion} fileDdl={issue.fileSuggestion} />
        ) : null}
        {issue.table && onOpenTable ? (
          <div className="issue-fix">
            <button className="btn btn-sm" onClick={() => onOpenTable(issue.table!)}>
              {t("openTable", { table: issue.table! })}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint ? <div>{hint}</div> : null}
    </div>
  );
}

export function Panel({
  title,
  count,
  actions,
  flush,
  scroll,
  children,
}: {
  title: string;
  count?: number | string;
  actions?: React.ReactNode;
  flush?: boolean;
  scroll?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <header className="panel-head">
        <span className="panel-title">{title}</span>
        {count !== undefined ? <span className="panel-count">{count}</span> : null}
        <span className="spacer" />
        {actions}
      </header>
      <div className={`${flush ? "panel-flush" : "panel-body"}${scroll ? " panel-scroll" : ""}`}>
        {children}
      </div>
    </section>
  );
}

/**
 * A button that shows a spinner while its action runs. The label stays in the
 * layout (only made transparent), so the button keeps its size and its
 * accessible name; `aria-busy` tells assistive technology it is working.
 */
export function BusyButton({
  busy,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy: boolean }) {
  return (
    <button {...props} disabled={busy || disabled} aria-busy={busy || undefined}>
      <span className="btn-label">{children}</span>
      {busy ? <span className="spinner btn-spinner" aria-hidden="true" /> : null}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 8 }} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {label ? <span className="dim small">{label}</span> : null}
    </span>
  );
}

/**
 * DDL has to be copied into the project's own SQL files as well as run here, so
 * every statement DBSCOPE shows is one click from the clipboard.
 */
function CopyButton({ text, source }: { text: string; source: RefObject<HTMLElement | null> }) {
  const { t } = usePreferences();
  const [copied, setCopied] = useState<{ text: string; ok: boolean } | null>(null);
  const state = copied?.text === text ? copied.ok : null;
  const label = state === true ? t("copied") : state === false ? t("copySelected") : t("copy");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ text, ok: true });
    } catch {
      // The Clipboard API needs a secure context, which a plain-http public
      // origin is not. Selecting the text still leaves Ctrl+C one key away.
      const range = document.createRange();
      range.selectNodeContents(source.current!);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      setCopied({ text, ok: false });
    }
  }

  return (
    <button
      type="button"
      className="ddl-copy"
      aria-label={label}
      title={label}
      data-state={state === true ? "copied" : undefined}
      onClick={() => void copy()}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {state === true ? (
          <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.6" />
        ) : (
          <g fill="none" stroke="currentColor" strokeWidth="1.3">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5" />
          </g>
        )}
      </svg>
    </button>
  );
}

function CodeBox({ text, kind }: { text: string; kind: "run" | "file" }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className="ddl-box">
      <pre ref={pre} className="raw" data-kind={kind}>
        {text}
      </pre>
      <CopyButton text={text} source={pre} />
    </div>
  );
}

/**
 * The statement DBSCOPE runs, and the same change as plain CREATE/DROP INDEX
 * for the project's schema or migration files.
 */
export function DdlBlock({
  ddl,
  fileDdl,
  className,
}: {
  ddl: string;
  fileDdl?: string | undefined;
  className?: string | undefined;
}) {
  const { t } = usePreferences();
  if (!fileDdl || fileDdl === ddl) {
    return (
      <div className={className ? `ddl-block ${className}` : "ddl-block"}>
        <CodeBox text={ddl} kind="run" />
      </div>
    );
  }
  return (
    <div className={className ? `ddl-block ${className}` : "ddl-block"}>
      <div className="ddl-label">{t("ddlForFile")}</div>
      <CodeBox text={fileDdl} kind="file" />
      <div className="ddl-label">{t("ddlRunHere")}</div>
      <CodeBox text={ddl} kind="run" />
    </div>
  );
}
