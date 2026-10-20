// dashboard/lib.js — ダッシュボードの純粋関数（DOM 非依存）
//
// `node --test dashboard/test/` でテストできるように、DOM を触る処理は
// ここに置かない。app.js はこのモジュールの戻り値だけを使って要素を組み立てる。

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// 表示上の上限・下限
export const MAX_ITER = 10_000_000;

/** 部署 ID → 日本語名（ARCHITECTURE §7） */
export const DEPT_NAMES = {
  pmo: '経営企画・PMO',
  product: 'プロダクト・調査',
  ux: 'UX・デザイン',
  eng: '技術・開発',
  qa: '品質・セキュリティ',
  mkt: 'マーケティング',
  ops: '運用・顧客対応',
  fin: '財務・事業管理',
  cross: '横断',
  orchestrator: '統括',
  advisor: '相談役',
  'computer-operator': 'コンピュータ操作',
  owner: 'オーナー',
};

/** 職階 ID → 日本語名 */
export const LEVEL_NAMES = {
  lead: '部長',
  exec: '実行',
  review: 'レビュー',
};

/** アプリのフェーズ ID → 日本語名（未知の値はそのまま出す） */
export const PHASE_LABELS = {
  discovery: '調査',
  validation: '検証',
  requirements: '要件',
  design: '設計',
  build_verify: 'ビルド・検証',
  launch: 'リリース準備',
  operate: '運用',
  closure: '終了',
};

/** 状態の表示名 */
export const STATUS_LABELS = {
  ok: '正常',
  down: '停止',
  unknown: '不明',
  fail: '失敗',
  failed: '失敗',
  error: 'エラー',
  stale: '停止',
  missing: '未取得',
  timeout: 'タイムアウト',
  running: '実行中',
  paused: '一時停止中',
  skipped: 'スキップ',
};

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * 日時として解釈できれば Date を返す。できないときは null。
 * `YYYY-MM-DD` はローカル時刻の 0:00 として扱う（UTC ずれを避ける）。
 */
export function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;
  const dateOnly = DATE_ONLY_RE.exec(s);
  if (dateOnly) {
    const d = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function nowMs(now) {
  const d = parseTime(now);
  return d ? d.getTime() : Date.now();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 経過時間。未来や不正値でも壊れない。 */
export function formatElapsed(value, now = Date.now()) {
  const d = parseTime(value);
  if (!d) return '不明';
  const diff = nowMs(now) - d.getTime();
  if (diff < MINUTE) return 'たった今';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}分前`;
  if (diff < DAY) {
    const hours = Math.floor(diff / HOUR);
    const minutes = Math.floor((diff % HOUR) / MINUTE);
    return minutes === 0 ? `${hours}時間前` : `${hours}時間${minutes}分前`;
  }
  return `${Math.floor(diff / DAY)}日前`;
}

/** 期限までの残り時間。過ぎていたら「期限切れ（…前）」。 */
export function formatRemaining(value, now = Date.now()) {
  const d = parseTime(value);
  if (!d) return '期限なし';
  const diff = nowMs(now) - d.getTime();
  if (diff >= 0) return `期限切れ（${formatElapsed(d, now)}）`;
  const left = -diff;
  if (left < HOUR) return `あと${Math.max(1, Math.floor(left / MINUTE))}分`;
  if (left < DAY) {
    const hours = Math.floor(left / HOUR);
    const minutes = Math.floor((left % HOUR) / MINUTE);
    return minutes === 0 ? `あと${hours}時間` : `あと${hours}時間${minutes}分`;
  }
  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  return hours === 0 ? `あと${days}日` : `あと${days}日${hours}時間`;
}

/**
 * 期限の切迫度。none / overdue / urgent（24 時間未満）/ normal。
 * 24 時間を切ったものだけ強調する。
 */
export function deadlineLevel(value, now = Date.now()) {
  const d = parseTime(value);
  if (!d) return 'none';
  const diff = nowMs(now) - d.getTime();
  if (diff >= 0) return 'overdue';
  return -diff < DAY ? 'urgent' : 'normal';
}

/** 心拍の健全度。15 分超で yellow、60 分超で red。 */
export function heartbeatLevel(value, now = Date.now()) {
  const d = parseTime(value);
  if (!d) return 'unknown';
  const minutes = (nowMs(now) - d.getTime()) / MINUTE;
  if (minutes > 60) return 'red';
  if (minutes > 15) return 'yellow';
  return 'ok';
}

/** 生成データを「古い」と見なすまでの分数。 */
export const STALE_AFTER_MINUTES = 120;

/**
 * 生成データの鮮度。generated_at が 120 分より古ければ 'stale'。
 * 120 分以内は 'ok'、欠落・不正な日時は 'unknown'（どちらも警告しない）。
 */
export function dataFreshness(value, now = Date.now()) {
  const d = parseTime(value);
  if (!d) return 'unknown';
  const minutes = (nowMs(now) - d.getTime()) / MINUTE;
  return minutes > STALE_AFTER_MINUTES ? 'stale' : 'ok';
}

/**
 * KPI の表示。null / undefined は 0 と混同せず「未取得：理由」にする。
 * 0 はそのまま 0。
 */
export function formatKpi(value, missingReason) {
  if (value === null || value === undefined) {
    const reason = typeof missingReason === 'string' ? missingReason.trim() : '';
    return reason === '' ? '未取得：理由未記録' : `未取得：${reason}`;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '未取得：数値が不正';
  }
  if (typeof value === 'boolean') return value ? 'あり' : 'なし';
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return formatKpi(null, missingReason);
    return s;
  }
  return String(value);
}

/** 金額。null は 0 にせず「未取得」。 */
export function formatUsd(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) {
    return '未取得';
  }
  return `$${n.toFixed(2)}`;
}

/** 達成率（0〜100 の整数）。分母が 0 以下や不正値は 0。 */
export function percent(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((p / t) * 100)));
}

/** https:// で始まる妥当な URL だけ許可する。 */
export function isSafeUrl(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (s === '' || /\s/.test(s)) return false;
  if (!/^https:\/\//i.test(s)) return false;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

/** 安全なリンク先。危険・不正なら null。 */
export function safeHref(value) {
  return isSafeUrl(value) ? value.trim() : null;
}

/** data:image/png;base64, で始まる PNG だけ許可する。 */
export function isSafeImage(value) {
  if (typeof value !== 'string') return false;
  const HEAD = 'data:image/png;base64,';
  if (!value.startsWith(HEAD)) return false;
  const body = value.slice(HEAD.length);
  if (body === '') return false;
  return B64_RE.test(body);
}

/** 安全な画像 URL。危険・不正・未生成なら null。 */
export function safeImageSrc(value) {
  return isSafeImage(value) ? value : null;
}

/** 部署 ID → 日本語名。未知はそのまま。 */
export function deptLabel(dept) {
  if (typeof dept !== 'string' || dept === '') return '不明';
  return DEPT_NAMES[dept] ?? dept;
}

/** `eng-exec` → `開発・実行`。未知の形はそのまま返す。 */
export function roleLabel(role) {
  if (typeof role !== 'string' || role === '') return '担当未定';
  const idx = role.lastIndexOf('-');
  if (idx <= 0) return DEPT_NAMES[role] ?? role;
  const dept = role.slice(0, idx);
  const level = role.slice(idx + 1);
  const d = DEPT_NAMES[dept];
  const l = LEVEL_NAMES[level];
  if (d && l) return `${d}・${l}`;
  return d ?? role;
}

/** フェーズ ID → 日本語名。 */
export function phaseLabel(phase) {
  if (typeof phase !== 'string' || phase === '') return '未設定';
  return PHASE_LABELS[phase] ?? phase;
}

/** 状態 ID → 日本語名。 */
export function statusLabel(status) {
  if (typeof status !== 'string' || status === '') return '不明';
  return STATUS_LABELS[status.toLowerCase()] ?? status;
}

/** 状態の色分け。ok / bad / unknown / info。 */
export function statusTone(status) {
  if (typeof status !== 'string' || status === '') return 'unknown';
  const s = status.toLowerCase();
  if (s === 'ok' || s === 'running') return 'ok';
  if (['down', 'fail', 'failed', 'error', 'stale', 'timeout'].includes(s)) return 'bad';
  if (['unknown', 'missing'].includes(s)) return 'unknown';
  return 'info';
}

/** 今日との日数差（ローカル日付）。未来は正、過去は負。 */
export function daysUntil(value, now = Date.now()) {
  const d = parseTime(value);
  if (!d) return null;
  const n = new Date(nowMs(now));
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const b = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((a.getTime() - b.getTime()) / DAY);
}

/** リリースまでの日数の表示。 */
export function formatDaysUntil(value, now = Date.now()) {
  const days = daysUntil(value, now);
  if (days === null) return '未取得';
  if (days > 1) return `あと${days}日`;
  if (days === 1) return 'あと1日';
  if (days === 0) return '今日';
  return `予定日を${-days}日過ぎています`;
}

/** `2026/10/19 11:05` */
export function formatDateTimeJa(value) {
  const d = parseTime(value);
  if (!d) return '不明';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `2026年10月19日` */
export function formatDateJa(value) {
  const d = parseTime(value);
  if (!d) return '不明';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/** `09:30` */
export function formatTimeJa(value) {
  const d = parseTime(value);
  if (!d) return '--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 0 時からの分数（秒は小数）。 */
export function minutesOfDay(value) {
  const d = parseTime(value);
  if (!d) return null;
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
}

/**
 * タイムラインのバー位置。0〜24 時の割合（%）で返す。
 * 終了が開始より前（日跨ぎ）なら 24 時で切る。最小幅 10 分。
 */
export function ganttSpan(start, end) {
  const s = minutesOfDay(start);
  if (s === null) return null;
  let e = minutesOfDay(end);
  if (e === null) e = s + 10;
  if (e < s) e = 24 * 60;
  const left = Math.min(Math.max(s, 0), 24 * 60);
  const right = Math.min(Math.max(e, left + 10), 24 * 60);
  return {
    leftPct: round3((left / (24 * 60)) * 100),
    widthPct: round3(((right - left) / (24 * 60)) * 100),
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/** 一覧の上位 N 件。 */
export function topN(list, n = 5) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, n);
}

/** 数値らしいものだけを取り出す（by_route の集計用）。 */
export function numericEntries(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
  return Object.entries(map)
    .filter(
      ([, value]) =>
        value !== null &&
        value !== undefined &&
        value !== '' &&
        typeof value !== 'boolean' &&
        Number.isFinite(Number(value)),
    )
    .map(([key, value]) => [key, Number(value)])
    .sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// 簡易 Markdown パーサ
//
// 戻り値は DOM ではなくプレーンなオブジェクトの配列。app.js がこれを
// document.createElement で組み立てる（innerHTML は使わない）。
//
// block:  {type:'heading', level, children}
//         {type:'paragraph', children}
//         {type:'list', ordered, items:[{children}]}
//         {type:'quote', children}
//         {type:'code', lang, text}
//         {type:'hr'}
// inline: {type:'text', text} / {type:'strong'|'em', children}
//         {type:'code', text} / {type:'link', href, children}
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^\s*[-*+]\s+(.*)$/;
const OL_RE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^\s*```(.*)$/;

const INLINE_RE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]*)\]\(([^)\s]+)\)/g;

function isBlockStart(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    UL_RE.test(line) ||
    OL_RE.test(line) ||
    QUOTE_RE.test(line)
  );
}

function nestInline(source, depth) {
  if (typeof source !== 'string' || source === '') return [];
  if (depth >= 2) return [{ type: 'text', text: source }];
  return parseInline(source, depth + 1);
}

/** 行内要素のパース。安全でないリンクはラベル文字列だけの text に落とす。 */
export function parseInline(source, depth = 0) {
  const nodes = [];
  if (typeof source !== 'string' || source === '') return nodes;
  const re = new RegExp(INLINE_RE.source, 'g');
  let last = 0;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (match.index > last) {
      nodes.push({ type: 'text', text: source.slice(last, match.index) });
    }
    if (match[1] !== undefined) {
      nodes.push({ type: 'code', text: match[1] });
    } else if (match[2] !== undefined || match[3] !== undefined) {
      nodes.push({ type: 'strong', children: nestInline(match[2] ?? match[3], depth) });
    } else if (match[4] !== undefined || match[5] !== undefined) {
      nodes.push({ type: 'em', children: nestInline(match[4] ?? match[5], depth) });
    } else if (match[6] !== undefined || match[7] !== undefined) {
      const label = match[6] ?? '';
      const href = safeHref(match[7] ?? '');
      const children = nestInline(label, depth);
      if (href) {
        nodes.push({ type: 'link', href, children });
      } else {
        nodes.push(...(children.length > 0 ? children : [{ type: 'text', text: label }]));
      }
    }
    last = re.lastIndex;
  }
  if (last < source.length) {
    nodes.push({ type: 'text', text: source.slice(last) });
  }
  return nodes;
}

/** 簡易 Markdown → ノード構造。壊れた入力でも空配列を返す。 */
export function parseMarkdown(text) {
  const blocks = [];
  if (typeof text !== 'string' || text === '') return blocks;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // 閉じフェンス
      blocks.push({ type: 'code', lang, text: buf.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2].trim()),
      });
      i += 1;
      continue;
    }

    if (HR_RE.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    if (UL_RE.test(line) || OL_RE.test(line)) {
      const ordered = OL_RE.test(line);
      const pattern = ordered ? OL_RE : UL_RE;
      const items = [];
      while (i < lines.length) {
        const item = pattern.exec(lines[i]);
        if (!item) break;
        items.push({ children: parseInline(item[1].trim()) });
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const buf = [];
      while (i < lines.length) {
        const quote = QUOTE_RE.exec(lines[i]);
        if (!quote) break;
        buf.push(quote[1].trim());
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(buf.join('\n')) });
      continue;
    }

    const buf = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      buf.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(buf.join('\n')) });
  }

  return blocks;
}
