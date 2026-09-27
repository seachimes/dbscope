import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Locale = "ja" | "en";
export type Theme = "system" | "light" | "dark";

type Messages = typeof en;
export type MessageKey = keyof Messages;

const en = {
  overview: "Overview",
  queries: "Queries",
  explain: "EXPLAIN",
  connection: "Connection",
  disconnect: "Disconnect",
  direct: "direct",
  sshTunnel: "SSH tunnel",
  restoring: "Restoring session…",
  inspector: "Database performance inspector",
  language: "Language",
  theme: "Theme",
  themeSystem: "System",
  themeLight: "Light",
  themeDark: "Dark",
  connectTag:
    "Find where database time is going. Nothing is installed on the server, and the database port never has to be exposed.",
  tunnelThroughSsh: "Tunnel through SSH",
  privateKey: "Private key",
  privateKeyHint: "A path on the DBSCOPE server, or paste the key itself.",
  sshPassphrase: "SSH key passphrase (if set)",
  sshPassphraseHint: "Required for an encrypted private key; not saved in the browser.",
  host: "Host",
  port: "Port",
  user: "User",
  password: "Password",
  postgresDbPasswordRequired:
    "Enter the PostgreSQL database password in the Database section (not the SSH key passphrase).",
  database: "Database",
  seenFromVm: "As seen from the SSH host",
  connect: "Connect",
  settingsRemembered: "Connection preferences are saved. Credentials are not.",
  directHint: "Connecting directly to the database.",
  refresh: "Refresh",
  hottestTable: "Hottest table",
  criticalIssues: "Critical issues",
  rows: "Rows",
  data: "Data",
  index: "Index",
  unindexedJoins: "Unindexed joins",
  fixFirst: "Fix these first",
  nothingObvious: "Nothing obvious",
  noRules: "No bottleneck rule matched this schema.",
  tables: "Tables",
  heat: "Heat",
  columnsShort: "Cols",
  queryTime: "Query time",
  rowsRead: "Rows read",
  issues: "Issues",
  clean: "Clean",
  startInvestigating: "Start investigating:",
  explainTable: "EXPLAIN a query against {table}",
  readingSchema: "Reading schema…",
  queryStatsOff: "Query statistics are off.",
  openTable: "Open {table}",
  apply: "Apply",
  queriesImpact: "Queries by impact",
  queriesSub: "Ranked by total time, not one slow execution.",
  resetCounters: "Reset query statistics",
  resetConfirmTitle: "Reset query statistics?",
  resetScopePostgres:
    "PostgreSQL: This clears pg_stat_statements counters for the connected database, including other users' queries.",
  resetConfirmDetail:
    "Existing measurements cannot be recovered. Table data and indexes are not changed.",
  cancel: "Cancel",
  perfUnavailable: "Query statistics are unavailable.",
  noQueries: "No queries recorded yet",
  runBenchmark: "Run the benchmark, then refresh.",
  distinctQueries: "Distinct queries",
  totalTime: "Total time",
  topShare: "Top query share",
  withoutIndex: "Without index",
  rankedQueries: "Ranked queries",
  retry: "Retry",
  readingQueries: "Reading query statistics…",
  total: "total",
  avg: "avg",
  calls: "calls",
  readPerReturned: "read per row returned",
  sendExplain: "Send to EXPLAIN",
  replacePlaceholder: "Replace each ? with a real value before explaining.",
  explainSub: "Read the plan as a pipeline. Wider connectors carry more rows.",
  analyze: "ANALYZE",
  sql: "SQL",
  analyzeWarning: "EXPLAIN ANALYZE actually runs the query and is limited to 5 seconds.",
  runExplain: "Explain",
  plan: "Plan",
  problems: "Problems",
  nothingFlagged: "Nothing flagged",
  planHealthy: "This plan looks healthy.",
  tryIndex: "Try an index",
  createCompare: "Create and compare",
  alreadyCovered: "already covered",
  rawOutput: "Raw output",
  show: "Show",
  hide: "Hide",
  nothingExplained: "Nothing explained yet",
  pasteQuery: "Paste a SELECT above.",
  before: "Before",
  after: "After",
  fewerRows: "{factor}× fewer rows",
  noChange: "No change",
  worse: "Worse",
  explainHere: "EXPLAIN a query here",
  schema: "Schema",
  indexes: "Indexes",
  tableQueries: "Queries",
  noTableQueries: "No recorded queries for this table",
  rowsPanel: "Rows",
  column: "Column",
  value: "Value",
  filter: "Filter",
  clear: "Clear",
  page: "page",
  ofApprox: "of ~",
  prev: "← Prev",
  next: "Next →",
  columns: "Columns",
  type: "Type",
  nullable: "Null",
  key: "Key",
  default: "Default",
  extra: "Extra",
  relations: "Relations",
  from: "From",
  to: "To",
  source: "Source",
  noRelations: "No relations found",
  currentIndexes: "Current indexes",
  name: "Name",
  unique: "Unique",
  cardinality: "Cardinality",
  primary: "primary",
  drop: "Drop",
  addIndex: "Add an index",
  selectColumns: "Click columns in index order",
  orderMatters: "Put equality columns first, then the sort column.",
  createIndex: "Create index",
  dropConfirm: "Drop index {index} from {table}? Query plans may change immediately.",
  createConfirm:
    "Create index on {table} ({columns})? Building it adds load, and the table may be locked while it runs.",
  graphHint: "drag to pan · Ctrl/⌘ + scroll to zoom · click a table",
  graphLegend: "SIZE = rows · COLOR = load",
  cold: "cold",
  hot: "hot",
  unindexedJoin: "join with no index",
  invalidIndex: "INVALID",
  engine: "Engine",
  rowsApprox:
    "Approximate: the planner's own estimate, not COUNT(*). MySQL samples index pages; PostgreSQL reports what the last ANALYZE saw. Two engines holding the same data can report slightly different totals.",
  skipHostKeyCheck: "Skip SSH host key check",
  hostKeyCheckedHint: "The host key is verified against ~/.ssh/known_hosts.",
  hostKeyInsecureHint: "Any host key will be accepted. Only do this on a network you trust.",
  invalidIndexHint:
    "Left behind by a failed CREATE INDEX CONCURRENTLY. It slows writes but cannot serve reads; drop it and retry.",
} as const;

const ja: Record<MessageKey, string> = {
  overview: "概要",
  queries: "クエリ",
  explain: "EXPLAIN",
  connection: "接続情報",
  disconnect: "切断",
  direct: "直接接続",
  sshTunnel: "SSHトンネル",
  restoring: "セッションを復元中…",
  inspector: "データベースパフォーマンスインスペクター",
  language: "言語",
  theme: "テーマ",
  themeSystem: "システム",
  themeLight: "ライト",
  themeDark: "ダーク",
  connectTag:
    "データベースのどこで時間を使っているかを見つけます。サーバーへの導入やDBポートの外部公開は不要です。",
  tunnelThroughSsh: "SSHトンネルを使用",
  privateKey: "秘密鍵",
  privateKeyHint: "DBSCOPEを動かしているマシン上のパス、または秘密鍵を貼り付けます。",
  sshPassphrase: "SSH鍵のパスフレーズ（設定している場合）",
  sshPassphraseHint: "暗号化された秘密鍵に必要です。ブラウザには保存しません。",
  host: "ホスト",
  port: "ポート",
  user: "ユーザー",
  password: "パスワード",
  postgresDbPasswordRequired:
    "PostgreSQLのDBパスワードを「Database」のパスワード欄に入力してください（SSH鍵のパスフレーズとは別です）。",
  database: "データベース",
  seenFromVm: "SSH接続先から見えるホスト名",
  connect: "接続",
  settingsRemembered: "接続先の設定だけ保存します。認証情報は保存しません。",
  directHint: "データベースへ直接接続します。",
  refresh: "更新",
  hottestTable: "最も高負荷",
  criticalIssues: "重大な問題",
  rows: "行数",
  data: "データ",
  index: "インデックス",
  unindexedJoins: "未索引JOIN",
  fixFirst: "最初に直す箇所",
  nothingObvious: "明らかな問題はありません",
  noRules: "ボトルネック検出ルールに該当しませんでした。",
  tables: "テーブル",
  heat: "負荷",
  columnsShort: "列",
  queryTime: "合計時間",
  rowsRead: "読取行数",
  issues: "問題",
  clean: "正常",
  startInvestigating: "調査を開始:",
  explainTable: "{table} のクエリをEXPLAIN",
  readingSchema: "スキーマを読込中…",
  queryStatsOff: "クエリ統計が無効です。",
  openTable: "{table}を開く",
  apply: "適用",
  queriesImpact: "Impact順クエリ",
  queriesSub: "1回の遅さではなく、合計実行時間の大きい順です。",
  resetCounters: "クエリ統計をリセット",
  resetConfirmTitle: "クエリ統計をリセットしますか？",
  resetScopePostgres:
    "PostgreSQL：接続中のデータベースのpg_stat_statements統計を消去します。他のユーザーのクエリも対象です。",
  resetConfirmDetail:
    "消した計測結果は元に戻せません。テーブルのデータやインデックスは変更しません。",
  cancel: "キャンセル",
  perfUnavailable: "クエリ統計を利用できません。",
  noQueries: "記録されたクエリがありません",
  runBenchmark: "ベンチマークを実行してから更新してください。",
  distinctQueries: "クエリ種類",
  totalTime: "合計時間",
  topShare: "最大Impact",
  withoutIndex: "INDEX未使用",
  rankedQueries: "クエリランキング",
  retry: "再試行",
  readingQueries: "クエリ統計を読込中…",
  total: "合計",
  avg: "平均",
  calls: "回",
  readPerReturned: "返却1行あたり読取",
  sendExplain: "EXPLAINへ送る",
  replacePlaceholder: "? を実際の値に置き換えてください。",
  explainSub: "実行計画を処理の流れで表示します。線が太いほど多くの行を処理します。",
  analyze: "ANALYZE",
  sql: "SQL",
  analyzeWarning: "EXPLAIN ANALYZEは実際にクエリを実行します。実行上限は5秒です。",
  runExplain: "実行計画を確認",
  plan: "実行計画",
  problems: "問題",
  nothingFlagged: "問題は検出されませんでした",
  planHealthy: "この実行計画は良好です。",
  tryIndex: "インデックスを試す",
  createCompare: "作成して比較",
  alreadyCovered: "既存INDEXで対応済み",
  rawOutput: "生の出力",
  show: "表示",
  hide: "非表示",
  nothingExplained: "まだ実行計画がありません",
  pasteQuery: "上にSELECT文を入力してください。",
  before: "改善前",
  after: "改善後",
  fewerRows: "処理行数 {factor}分の1",
  noChange: "変化なし",
  worse: "悪化",
  explainHere: "このテーブルのクエリをEXPLAIN",
  schema: "スキーマ",
  indexes: "インデックス",
  tableQueries: "クエリ",
  noTableQueries: "このテーブルのクエリは記録されていません",
  rowsPanel: "データ",
  column: "カラム",
  value: "値",
  filter: "絞り込む",
  clear: "クリア",
  page: "ページ",
  ofApprox: "/ 約",
  prev: "← 前へ",
  next: "次へ →",
  columns: "カラム",
  type: "型",
  nullable: "NULL",
  key: "キー",
  default: "デフォルト",
  extra: "その他",
  relations: "リレーション",
  from: "参照元",
  to: "参照先",
  source: "検出元",
  noRelations: "リレーションがありません",
  currentIndexes: "現在のインデックス",
  name: "名前",
  unique: "ユニーク",
  cardinality: "カーディナリティ",
  primary: "主キー",
  drop: "削除",
  addIndex: "インデックスを追加",
  selectColumns: "インデックス順にカラムを選択",
  orderMatters: "等価条件のカラムを先に、ソート対象を後にします。",
  createIndex: "インデックス作成",
  dropConfirm: "{table} の {index} を削除しますか？実行計画が即座に変化する可能性があります。",
  createConfirm:
    "{table} ({columns}) にインデックスを作成しますか？作成中にテーブルへ負荷がかかる可能性があります。",
  graphHint: "ドラッグで移動 · Ctrl/⌘+スクロールで拡大 · クリックで詳細",
  graphLegend: "サイズ = 行数 · 色 = 負荷",
  cold: "低負荷",
  hot: "高負荷",
  unindexedJoin: "インデックスのないJOIN",
  invalidIndex: "無効",
  engine: "データベース",
  rowsApprox:
    "概算値です。COUNT(*)ではなくプランナの推定行数を表示しています。MySQLはインデックスページの標本から、PostgreSQLは直近のANALYZE結果から算出するため、同じデータでも両者の値は多少異なります。",
  skipHostKeyCheck: "SSHホスト鍵の検証をスキップ",
  hostKeyCheckedHint: "ホスト鍵を ~/.ssh/known_hosts と照合します。",
  hostKeyInsecureHint:
    "任意のホスト鍵を受け入れます。信頼できるネットワークでのみ使用してください。",
  invalidIndexHint:
    "CREATE INDEX CONCURRENTLY の失敗で残ったインデックスです。書き込みを遅くする一方で検索には使用されません。削除してから再作成してください。",
};

interface PreferencesValue {
  locale: Locale;
  theme: Theme;
  resolvedTheme: "light" | "dark";
  setLocale: (v: Locale) => void;
  setTheme: (v: Theme) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

const Context = createContext<PreferencesValue | null>(null);

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(
    () =>
      (localStorage.getItem("dbscope.locale") as Locale) ||
      (navigator.language.startsWith("ja") ? "ja" : "en"),
  );
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem("dbscope.theme") as Theme) || "system",
  );
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.lang = locale;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [locale, resolvedTheme]);

  const value = useMemo<PreferencesValue>(
    () => ({
      locale,
      theme,
      resolvedTheme,
      setLocale: (v) => {
        setLocaleState(v);
        localStorage.setItem("dbscope.locale", v);
      },
      setTheme: (v) => {
        setThemeState(v);
        localStorage.setItem("dbscope.theme", v);
      },
      t: (key, vars) => {
        let text: string = (locale === "ja" ? ja[key] : en[key]) ?? en[key];
        for (const [name, value] of Object.entries(vars ?? {}))
          text = text.replaceAll(`{${name}}`, String(value));
        return text;
      },
    }),
    [locale, theme, resolvedTheme],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function usePreferences(): PreferencesValue {
  const value = useContext(Context);
  if (!value) throw new Error("PreferencesProvider missing");
  return value;
}

export function PreferenceControls({ compact = false }: { compact?: boolean }) {
  const { locale, theme, setLocale, setTheme, t } = usePreferences();
  return (
    <div className={`preference-controls${compact ? " preference-controls-compact" : ""}`}>
      <label className="preference-select">
        <span className="sr-only">{t("language")}</span>
        <select
          aria-label={t("language")}
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          <option value="ja">日本語</option>
          <option value="en">English</option>
        </select>
        <span className="preference-chevron" aria-hidden="true" />
      </label>
      <label className="preference-select">
        <span className="sr-only">{t("theme")}</span>
        <select
          aria-label={t("theme")}
          value={theme}
          onChange={(e) => setTheme(e.target.value as Theme)}
        >
          <option value="system">{t("themeSystem")}</option>
          <option value="light">{t("themeLight")}</option>
          <option value="dark">{t("themeDark")}</option>
        </select>
        <span className="preference-chevron" aria-hidden="true" />
      </label>
    </div>
  );
}
