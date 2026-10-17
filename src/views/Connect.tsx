import { useState } from "react";
import type { ConnectRequest, SessionInfo } from "#shared/types.ts";
import { api, setSessionId } from "../lib/api.ts";
import { BusyButton } from "../components/common.tsx";
import { loadConnectionSettings, saveConnectionSettings } from "../lib/connect-settings.ts";
import { PreferenceControls, usePreferences } from "../lib/preferences.tsx";

interface FormState {
  engine: "mysql" | "postgres";
  useSsh: boolean;
  /** Opt-in: host keys are verified against ~/.ssh/known_hosts by default. */
  skipHostKeyCheck: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshKey: string;
  sshPassphrase: string;
  dbHost: string;
  dbPort: string;
  dbUser: string;
  dbPass: string;
  dbName: string;
}

const DEFAULTS: FormState = {
  engine: "mysql",
  useSsh: true,
  skipHostKeyCheck: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshKey: "~/.ssh/id_ed25519",
  sshPassphrase: "",
  dbHost: "127.0.0.1",
  dbPort: "3306",
  dbUser: "",
  dbPass: "",
  dbName: "",
};

function loadSaved(): FormState {
  try {
    return {
      ...DEFAULTS,
      ...loadConnectionSettings(localStorage),
      dbPass: "",
      sshKey: DEFAULTS.sshKey,
      sshPassphrase: "",
    };
  } catch {
    return DEFAULTS;
  }
}

export function Connect({ onConnected }: { onConnected: (info: SessionInfo) => void }) {
  const { t } = usePreferences();
  const [form, setForm] = useState<FormState>(loadSaved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (form.engine === "postgres" && !form.dbPass) {
      setError(t("postgresDbPasswordRequired"));
      document.getElementById("dbPass")?.focus();
      return;
    }
    setBusy(true);
    setError(null);

    const request: ConnectRequest = {
      engine: form.engine,
      ssh: form.useSsh
        ? {
            host: form.sshHost.trim(),
            port: Number(form.sshPort) || 22,
            user: form.sshUser.trim(),
            privateKey: form.sshKey.trim(),
            ...(form.sshPassphrase ? { passphrase: form.sshPassphrase } : {}),
            hostKeyPolicy: form.skipHostKeyCheck ? "insecure" : "known_hosts",
          }
        : null,
      mysql: {
        host: form.dbHost.trim(),
        port: Number(form.dbPort) || (form.engine === "postgres" ? 5432 : 3306),
        user: form.dbUser.trim(),
        password: form.dbPass,
        database: form.dbName.trim(),
      },
    };

    try {
      const info = await api.connect(request);
      setSessionId(info.id);
      saveConnectionSettings(localStorage, form as unknown as Record<string, unknown>);
      onConnected(info);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="connect-wrap">
      <form className="connect" onSubmit={submit}>
        <header className="connect-head">
          <div className="connect-preferences">
            <PreferenceControls />
          </div>
          <h1 className="connect-title">
            DBSCOPE
            <span className="brand-dot" />
            <span className="brand-version" title={__DBSCOPE_VERSION__}>
              {__DBSCOPE_VERSION__}
            </span>
          </h1>
          <p className="connect-tag">{t("connectTag")}</p>
        </header>

        <div className="card">
          <div className="card-head">
            <span className="card-title">SSH</span>
            <span className="card-rule" />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={form.useSsh}
                onChange={(e) => set("useSsh", e.target.checked)}
              />
              {t("tunnelThroughSsh")}
            </label>
          </div>

          {form.useSsh ? (
            <>
              <div className="grid-3">
                <div className="field">
                  <label htmlFor="sshHost">{t("host")}</label>
                  <input
                    id="sshHost"
                    value={form.sshHost}
                    onChange={(e) => set("sshHost", e.target.value)}
                    placeholder="203.0.113.10"
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="sshPort">{t("port")}</label>
                  <input
                    id="sshPort"
                    value={form.sshPort}
                    onChange={(e) => set("sshPort", e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="sshUser">{t("user")}</label>
                  <input
                    id="sshUser"
                    value={form.sshUser}
                    onChange={(e) => set("sshUser", e.target.value)}
                  />
                </div>
              </div>
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="sshKey">{t("privateKey")}</label>
                {/* A textarea, because a pasted key is multi-line: an <input>
                    strips the newlines and leaves an unparseable key. */}
                <textarea
                  id="sshKey"
                  className="key-input"
                  rows={1}
                  spellCheck={false}
                  autoComplete="off"
                  value={form.sshKey}
                  onChange={(e) => set("sshKey", e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                />
                <span className="field-hint">{t("privateKeyHint")}</span>
              </div>
              <div className="field" style={{ marginTop: 12 }}>
                <label htmlFor="sshPassphrase">{t("sshPassphrase")}</label>
                <input
                  id="sshPassphrase"
                  type="password"
                  autoComplete="off"
                  value={form.sshPassphrase}
                  onChange={(e) => set("sshPassphrase", e.target.value)}
                />
                <span className="field-hint">{t("sshPassphraseHint")}</span>
              </div>
              <div className="field" style={{ marginTop: 12 }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.skipHostKeyCheck}
                    onChange={(e) => set("skipHostKeyCheck", e.target.checked)}
                  />
                  {t("skipHostKeyCheck")}
                </label>
                <span className="field-hint">
                  {form.skipHostKeyCheck ? t("hostKeyInsecureHint") : t("hostKeyCheckedHint")}
                </span>
              </div>
            </>
          ) : (
            <div className="field-hint">{t("directHint")}</div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <span className="card-title">Database</span>
            <span className="card-rule" />
            <select
              className="engine-select"
              aria-label="Database engine"
              value={form.engine}
              onChange={(e) => {
                const engine = e.target.value as FormState["engine"];
                setForm((f) => ({
                  ...f,
                  engine,
                  dbPort:
                    engine === "postgres" && f.dbPort === "3306"
                      ? "5432"
                      : engine === "mysql" && f.dbPort === "5432"
                        ? "3306"
                        : f.dbPort,
                  dbHost:
                    engine === "postgres" && f.dbHost === "mysql"
                      ? "postgres"
                      : engine === "mysql" && f.dbHost === "postgres"
                        ? "mysql"
                        : f.dbHost,
                }));
              }}
            >
              <option value="mysql">MySQL</option>
              <option value="postgres">PostgreSQL</option>
            </select>
          </div>

          <div className="grid-3">
            <div className="field">
              <label htmlFor="dbHost">{t("host")}</label>
              <input
                id="dbHost"
                value={form.dbHost}
                onChange={(e) => set("dbHost", e.target.value)}
              />
              <span className="field-hint">{form.useSsh ? t("seenFromVm") : t("direct")}</span>
            </div>
            <div className="field">
              <label htmlFor="dbPort">{t("port")}</label>
              <input
                id="dbPort"
                value={form.dbPort}
                onChange={(e) => set("dbPort", e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="dbName">{t("database")}</label>
              <input
                id="dbName"
                value={form.dbName}
                onChange={(e) => set("dbName", e.target.value)}
                required
              />
            </div>
          </div>

          <div className="grid-2" style={{ marginTop: 12 }}>
            <div className="field">
              <label htmlFor="dbUser">{t("user")}</label>
              <input
                id="dbUser"
                value={form.dbUser}
                onChange={(e) => set("dbUser", e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="dbPass">{t("password")}</label>
              <input
                id="dbPass"
                type="password"
                autoComplete="off"
                required={form.engine === "postgres"}
                value={form.dbPass}
                onChange={(e) => set("dbPass", e.target.value)}
              />
            </div>
          </div>
        </div>

        {error ? <div className="error-box">{error}</div> : null}

        <div className="btn-row">
          <BusyButton className="btn btn-primary" type="submit" busy={busy}>
            {t("connect")}
          </BusyButton>
          <span className="spacer" />
          <span className="faint small mono">{t("settingsRemembered")}</span>
        </div>
      </form>
    </div>
  );
}
