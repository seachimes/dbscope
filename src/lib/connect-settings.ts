// Keep connection preferences, never credentials. Older releases stored the
// entire SSH key field; reading a saved record must also erase that old copy.
const STORE_KEY = "dbscope.connect.form";
const LEGACY_STORE_KEY = "sonde.connect.form";
const SENSITIVE = new Set(["dbPass", "sshKey", "sshPassphrase", "passphrase"]);

export function loadConnectionSettings(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): Record<string, unknown> {
  const raw = storage.getItem(STORE_KEY) ?? storage.getItem(LEGACY_STORE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const safe = Object.fromEntries(Object.entries(parsed).filter(([key]) => !SENSITIVE.has(key)));
    storage.setItem(STORE_KEY, JSON.stringify(safe));
    return safe;
  } catch {
    storage.removeItem(STORE_KEY);
    return {};
  } finally {
    storage.removeItem(LEGACY_STORE_KEY);
  }
}

export function saveConnectionSettings(
  storage: Pick<Storage, "setItem">,
  form: Record<string, unknown>,
): void {
  storage.setItem(
    STORE_KEY,
    JSON.stringify(Object.fromEntries(Object.entries(form).filter(([key]) => !SENSITIVE.has(key)))),
  );
}
