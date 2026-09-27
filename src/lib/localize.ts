import type { Issue, PlanStep, QueryAdvice } from "#shared/types.ts";
import type { Locale } from "./preferences.tsx";

const issueJa: Record<string, { title: string; detail: string }> = {
  N_PLUS_ONE: {
    title: "N+1の可能性があります",
    detail:
      "同じ軽量クエリが大量に実行されています。呼び出し元でIDをまとめて取得できないか確認してください。",
  },
  LARGE_OFFSET: {
    title: "OFFSETページングを見直してください",
    detail: "後続ページほど読み飛ばす行が増えます。最終キーを使ったページングを検討してください。",
  },
  LEADING_WILDCARD: {
    title: "前方ワイルドカード検索",
    detail:
      "通常のB-treeインデックスでは効率化できません。FULLTEXTや検索方式の変更を検討してください。",
  },
  NON_SARGABLE: {
    title: "インデックスを利用しにくい条件です",
    detail: "カラムを関数で包まず、範囲条件や生成カラムへ書き換えてください。",
  },
  CORRELATED_SUBQUERY: {
    title: "相関サブクエリの可能性があります",
    detail:
      "外側の各行で内側のSELECTが繰り返されていないか確認し、JOINや事前集計と比較してください。",
  },
  NO_PRIMARY_KEY: {
    title: "主キーがありません",
    detail: "主キーのないInnoDBテーブルは行の特定やレプリケーションで不利になります。",
  },
  LOW_INDEX_COVERAGE: {
    title: "セカンダリインデックスが不足しています",
    detail: "WHERE・JOIN・ORDER BYで使うカラムに適切なインデックスがあるか確認してください。",
  },
  UNINDEXED_FK: {
    title: "JOINカラムにインデックスがありません",
    detail: "このリレーションの結合や絞り込みではテーブル全体を読む可能性があります。",
  },
  FULL_SCAN: {
    title: "フルテーブルスキャン",
    detail: "条件に使えるインデックスがなく、テーブルの全行を読み取っています。",
  },
  HUGE_ROWS: {
    title: "大量の行を処理しています",
    detail: "返却結果に対して読み取る行が多すぎます。条件とインデックスを確認してください。",
  },
  TEMPORARY: {
    title: "一時テーブルを使用",
    detail: "集約や並べ替えのため一時テーブルを作成しています。",
  },
  FILESORT: {
    title: "ファイルソートを使用",
    detail: "インデックス順を利用できず、読み取った行を追加でソートしています。",
  },
  SELECT_STAR: {
    title: "SELECT * を使用",
    detail: "不要なカラムの転送と、カバリングインデックスの機会損失につながります。",
  },
  NO_INDEX: {
    title: "インデックス未使用",
    detail: "このアクセスでは利用可能なインデックスがありません。",
  },
};

export function localizedIssue(issue: Issue, locale: Locale): Issue {
  if (locale !== "ja") return issue;
  const translated = issueJa[issue.code];
  if (!translated) return issue;
  const scope = issue.table ? `${issue.table}: ` : "";
  return { ...issue, title: `${scope}${translated.title}`, detail: translated.detail };
}

const planLabelsJa: Record<string, string> = {
  "FULL SCAN": "全行スキャン",
  "INDEX-ORDER SCAN": "インデックス順走査",
  "RANGE SCAN": "範囲スキャン",
  "INDEX LOOKUP": "インデックス検索",
  "UNIQUE LOOKUP": "一意検索",
  CONST: "定数アクセス",
  "INDEX LOOKUP (+NULL)": "インデックス検索（NULL含む）",
  "INDEX MERGE": "インデックス統合",
  ACCESS: "アクセス",
  JOIN: "結合",
  FILESORT: "ファイルソート",
  "TEMP TABLE": "一時テーブル",
  LIMIT: "件数制限",
};

export function localizedAdvice(advice: QueryAdvice, locale: Locale): QueryAdvice {
  if (locale !== "ja") return advice;
  const title = advice.title;
  if (/Possible N\+1/.test(title))
    return {
      ...advice,
      title: `N+1の可能性: 同じ検索を${title.match(/[\d,]+/)?.[0] ?? "多数"}回実行`,
      detail:
        "1回は軽量でも、一覧の各行から呼ばれていると合計コストが増えます。INDEX追加より先に、IN句での一括取得・JOIN・事前ロードを検討してください。",
    };
  if (/Fetch only/.test(title))
    return {
      ...advice,
      title: "必要なカラムだけを取得",
      detail:
        "SELECT * は不要なTEXT/BLOBも転送し、カバリングインデックスを使える機会を失います。まず返却に必要なカラムへ限定してください。",
    };
  if (/keyset/.test(title))
    return {
      ...advice,
      title: "OFFSETではなくキーセットページングを使用",
      detail:
        "大きなOFFSETは前の行を毎回読み捨てます。最後に取得したソートキーから続けてください。",
    };
  if (/wildcard/.test(title))
    return {
      ...advice,
      title: "前方ワイルドカードは通常のINDEXでは改善しません",
      detail:
        "LIKE '%term%' はB-treeで検索開始位置を決められません。FULLTEXT・前方一致・専用検索テーブルを検討してください。",
    };
  if (/sargable/.test(title))
    return {
      ...advice,
      title: "検索条件をINDEX利用可能な形へ変更",
      detail:
        "カラムに関数を適用すると通常のINDEX検索を妨げます。定数側の変換、範囲条件、生成カラムを検討してください。",
    };
  if (/correlated/.test(title))
    return {
      ...advice,
      title: "相関サブクエリを確認",
      detail:
        "内側のSELECTが外側の各行で実行される場合があります。JOIN・EXISTS・事前集計とEXPLAIN ANALYZEで比較してください。",
    };
  if (/DISTINCT/.test(title))
    return {
      ...advice,
      title: "DISTINCTが本当に必要か確認",
      detail: "JOINによる重複をDISTINCTで隠している場合、結合条件を直す方が低コストです。",
    };
  if (/RAND/.test(title))
    return {
      ...advice,
      title: "大きなテーブルでORDER BY RAND()を避ける",
      detail:
        "候補行すべてに乱数を付けてソートします。ID範囲からのサンプリングやランダムキーを検討してください。",
    };
  return advice;
}

export function localizedStep(step: PlanStep, locale: Locale): PlanStep {
  if (locale !== "ja") return step;
  return {
    ...step,
    label: planLabelsJa[step.label] ?? step.label,
    sublabel: step.sublabel?.replace(/^key: /, "キー: ").replace(/^on /, "条件: "),
    notes: step.notes.map((note) => {
      if (/Reads every row/.test(note)) return "テーブルの全行を読み取ります。";
      if (/Walks a large part/.test(note))
        return "キー検索ではなく、インデックスの広い範囲を順番に走査します。";
      if (/Reads the index in order/.test(note))
        return "インデックス順に読み取ります。LIMITで少数行だけ取得する場合は効率的です。";
      if (/bounded slice/.test(note)) return "インデックスの限定された範囲を読み取ります。";
      if (/At most one row/.test(note)) return "最大1行だけ取得する効率的なアクセスです。";
      if (/No index used/.test(note)) return "インデックスを使用していません。";
      if (/filtered after/.test(note)) return "読み取り後に行を絞り込んでいます。";
      if (/Covering index/.test(note))
        return "カバリングインデックスによりテーブル本体を読みません。";
      if (/join buffer/.test(note))
        return "利用可能なインデックスがなく、JOINバッファを使用しています。";
      return note;
    }),
  };
}
