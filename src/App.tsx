import { useEffect, useState } from "react";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import type { SessionInfo } from "#shared/types.ts";
import { api, getSessionId, setSessionExpiredHandler, setSessionId } from "./lib/api.ts";
import { Connect } from "./views/Connect.tsx";
import { Overview } from "./views/Overview.tsx";
import { TableDetail } from "./views/TableDetail.tsx";
import { Queries } from "./views/Queries.tsx";
import { Explain } from "./views/Explain.tsx";
import { PreferenceControls, usePreferences } from "./lib/preferences.tsx";

const NAV = [
  { key: "overview" as const, to: "/overview" as const, hotkey: "1" },
  { key: "queries" as const, to: "/queries" as const, hotkey: "2" },
  { key: "explain" as const, to: "/explain" as const, hotkey: "3" },
];

export function AppShell() {
  const { t } = usePreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const id = getSessionId();
    if (!id) {
      setChecking(false);
      return;
    }
    fetch("/api/session", { headers: { "x-dbscope-session": id } })
      .then((r) => {
        if (!r.ok) throw new Error("session expired");
        return r.json() as Promise<SessionInfo>;
      })
      .then(setSession)
      .catch(() => setSessionId(null))
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setSession(null);
      void navigate({ to: "/", replace: true });
    });
    return () => setSessionExpiredHandler(null);
  }, [navigate]);

  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.closest("dialog:modal") ||
        (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      )
        return;
      const hit = NAV.find((item) => item.hotkey === e.key);
      if (hit) void navigate({ to: hit.to });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, navigate]);

  if (checking)
    return (
      <div className="loading-view">
        <span className="spinner" /> {t("restoring")}
      </div>
    );

  if (!session) {
    return (
      <Connect
        onConnected={(info) => {
          setSession(info);
          void navigate({
            to: location.pathname === "/" ? "/overview" : location.pathname,
            replace: true,
          });
        }}
      />
    );
  }

  if (location.pathname === "/") {
    void navigate({ to: "/overview", replace: true });
    return (
      <div className="loading-view">
        <span className="spinner" />
      </div>
    );
  }

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main navigation">
        <Link to="/overview" className="brand brand-link">
          <div className="brand-mark">
            <span className="brand-name">DBSCOPE</span>
            <span className="brand-dot" />
            <span className="brand-version" title={__DBSCOPE_VERSION__}>
              {__DBSCOPE_VERSION__}
            </span>
          </div>
        </Link>
        <div className="nav">
          {/* Overview also covers /tables/*, so it stays highlighted while a table
            is open; the other entries match their own route exactly. */}
          {NAV.map((item) => (
            <Link
              key={item.key}
              to={item.to}
              className="nav-item"
              activeProps={{ "aria-current": "page" }}
              activeOptions={{ exact: item.key !== "overview", includeSearch: false }}
            >
              {t(item.key)}
              <span className="nav-key">{item.hotkey}</span>
            </Link>
          ))}
        </div>
        <div className="rail-section rail-preferences">
          <PreferenceControls compact />
        </div>
        <div className="rail-section">
          <div className="rail-label">{t("connection")}</div>
          <div className="conn-line">
            <span>db</span>
            <b>{session.database}</b>
          </div>
          <div className="conn-line">
            <span>{session.engine === "postgres" ? "postgres" : "mysql"}</span>
            <b>{session.mysqlVersion.split("-")[0]}</b>
          </div>
          <div className="conn-line">
            <span>via</span>
            <b>{session.viaSsh ? t("sshTunnel") : t("direct")}</b>
          </div>
          {/* Name the actual source: performance_schema and pg_stat_statements have
            different availability rules, and the label is how a user knows which
            one to enable. */}
          <div className="conn-line">
            <span>{session.engine === "postgres" ? "pg_stat_stmts" : "perf_schema"}</span>
            <b
              style={{
                color: session.performanceSchema.digestEnabled ? "var(--ok)" : "var(--warn)",
              }}
            >
              {session.performanceSchema.digestEnabled ? "on" : "off"}
            </b>
          </div>
          <button
            className="btn btn-sm"
            style={{ width: "100%", marginTop: 10 }}
            onClick={async () => {
              await api.disconnect().catch(() => {});
              setSessionId(null);
              setSession(null);
              void navigate({ to: "/", replace: true });
            }}
          >
            {t("disconnect")}
          </button>
        </div>
      </nav>
      <main className="main">
        <RouteContent session={session} />
      </main>
    </div>
  );
}

function RouteContent({ session }: { session: SessionInfo }) {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams({ strict: false }) as { table?: string };
  const search = useSearch({ strict: false }) as { sql?: string };
  const openExplain = (sql: string) => void navigate({ to: "/explain", search: { sql } });

  if (location.pathname === "/overview")
    return (
      <Overview
        onSelectTable={(table) => void navigate({ to: "/tables/$table", params: { table } })}
      />
    );
  if (location.pathname.startsWith("/tables/") && params.table)
    return <TableDetail table={params.table} engine={session.engine} onExplain={openExplain} />;
  if (location.pathname === "/queries")
    return <Queries canReset={session.engine === "postgres"} onExplain={openExplain} />;
  if (location.pathname === "/explain")
    return <Explain session={session} initialSql={search.sql ?? ""} />;
  return <Outlet />;
}
