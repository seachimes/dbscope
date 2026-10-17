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
  const ddl = useRef<HTMLElement>(null);
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
          <div className="issue-fix">
            <code ref={ddl} className="issue-ddl">
              {issue.suggestion}
            </code>
            <CopyButton text={issue.suggestion} source={ddl} />
          </div>
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
 * DDL has to be copied into the project's schema file as well as run here, so
 * every statement DBSCOPE shows is one click from the clipboard.
 */
export function CopyButton({
  text,
  source,
}: {
  text: string;
  source: RefObject<HTMLElement | null>;
}) {
  const { t } = usePreferences();
  const [copied, setCopied] = useState<{ text: string; ok: boolean } | null>(null);
  const state = copied?.text === text ? copied.ok : null;

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
    <button type="button" className="btn btn-sm ddl-copy" onClick={() => void copy()}>
      {state === true ? t("copied") : state === false ? t("copySelected") : t("copy")}
    </button>
  );
}

export function DdlBlock({ ddl, className }: { ddl: string; className?: string }) {
  const pre = useRef<HTMLPreElement>(null);
  return (
    <div className={className ? `ddl-block ${className}` : "ddl-block"}>
      <pre ref={pre} className="raw">
        {ddl}
      </pre>
      <CopyButton text={ddl} source={pre} />
    </div>
  );
}
