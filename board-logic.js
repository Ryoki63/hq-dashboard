// かんばんの純粋ロジック(DOM 非依存)。board.js が import し、同じ関数を re-export する。
import { formatRemaining, parseTime } from './lib.js';

/** 投稿先として許可する唯一のリポジトリ(大文字小文字を区別して厳密一致)。 */
export const ALLOWED_REPO = 'Ryoki63/solo-company';
export const MAX_REASON_LENGTH = 1000;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const VERDICT_LABELS = { approve: '承認', hold: '保留', reject: '見送り' };
const TOKEN_PREFIXES = ['ghp_', 'github_pat_', 'gho_', 'ghu_', 'ghs_'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** 期限の「実際の失効時刻(ms)」。日付のみは JST のその日の終わり(翌日 0:00 JST)。不正なら null。 */
export function deadlineInstant(deadline) {
  if (typeof deadline === 'string') {
    const m = DATE_ONLY_RE.exec(deadline.trim());
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      const probe = new Date(Date.UTC(y, mo - 1, d));
      if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
      return Date.UTC(y, mo - 1, d + 1) - JST_OFFSET_MS;
    }
  }
  const t = parseTime(deadline);
  return t ? t.getTime() : null;
}

function resolveNow(now) {
  const t = parseTime(now);
  return t ? t.getTime() : Date.now();
}

/**
 * decisions を列ごとに分ける。入力順を維持。
 * pending で期限切れ(日付のみは JST 23:59:59 まで有効)のものは hold。
 */
export function classifyDecisions(decisions, now) {
  const out = { pending: [], approved: [], hold: [], rejected: [] };
  if (!Array.isArray(decisions)) return out;
  const nowMs = resolveNow(now);
  for (const d of decisions) {
    if (!isObject(d)) continue;
    if (typeof d.id !== 'string' || d.id.trim() === '') continue;
    const status = d.status === undefined || d.status === null || d.status === '' ? 'pending' : d.status;
    if (status === 'approved') out.approved.push(d);
    else if (status === 'rejected') out.rejected.push(d);
    else if (status === 'pending') {
      const limit = deadlineInstant(d.deadline);
      if (limit !== null && nowMs >= limit) out.hold.push(d);
      else out.pending.push(d);
    }
  }
  return out;
}

/** 表示用の残り時間(日本語)。日付のみの期限は JST のその日の終わりまで。 */
export function remainingLabel(deadline, now) {
  const limit = deadlineInstant(deadline);
  if (limit === null) return '期限なし';
  return formatRemaining(limit, resolveNow(now));
}

// ---- コメント本文 ----

/** 制御文字・HTML コメント記号・エージェント印を除去し 1 行に畳む。 */
function sanitizeText(value) {
  let s = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ');
  let prev;
  do {
    prev = s;
    s = s.replace(/<!--|--!?>|<!|hq-agent/gi, '');
  } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('').trim() : s;
}

/**
 * GitHub に投稿するコメント本文。verdict: 'approve' | 'hold' | 'reject'。
 * エージェント印は含めない。理由は無害化し 1000 文字で切る。
 */
export function buildCommentBody(decision, verdict, choiceKey, reason) {
  const verdictLabel = VERDICT_LABELS[verdict];
  if (!verdictLabel) throw new Error(`unknown verdict: ${String(verdict)}`);
  const id = sanitizeText(isObject(decision) ? decision.id : '') || '(ID不明)';
  const lines = [`【ダッシュボードから決定】${id}`, `決定: ${verdictLabel}`];
  if (verdict === 'approve') {
    const key = sanitizeText(choiceKey);
    if (key) {
      const opts = isObject(decision) ? normalizeOptions(decision) : [];
      const opt = opts.find((o) => o.key === key);
      const head = sanitizeText(opt && opt.key ? `案${opt.key}` : key.length <= 2 ? `案${key}` : key);
      const detail = sanitizeText((opt && (opt.effect || opt.label)) || '');
      lines.push(detail && detail !== head && detail !== key ? `選択肢: ${head} — ${detail}` : `選択肢: ${head}`);
    }
  }
  const r = truncate(sanitizeText(reason), MAX_REASON_LENGTH);
  lines.push(`理由: ${r || '(記載なし)'}`);
  return lines.join('\n');
}

// ---- Issue 参照 / トークン ----

const ISSUE_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/([1-9][0-9]*)$/;

function toIssueNumber(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === 'string' && /^[1-9][0-9]*$/.test(v.trim())) {
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** 投稿先 {repo, number}。許可リスト外の repo や不正な形は null。 */
export function parseIssueRef(decision) {
  if (!isObject(decision)) return null;
  const hasRepo = decision.issue_repo !== undefined && decision.issue_repo !== null && decision.issue_repo !== '';
  const number = toIssueNumber(decision.issue_number);
  if (hasRepo && number !== null) {
    return decision.issue_repo === ALLOWED_REPO ? { repo: ALLOWED_REPO, number } : null;
  }
  if (typeof decision.issue_url === 'string') {
    const m = ISSUE_URL_RE.exec(decision.issue_url.trim());
    if (m) {
      const repo = `${m[1]}/${m[2]}`;
      const n = toIssueNumber(m[3]);
      if (repo === ALLOWED_REPO && n !== null) return { repo, number: n };
    }
  }
  return null;
}

/** 形式だけの検証(厳密な検証はしない)。 */
export function validateToken(token) {
  if (typeof token !== 'string') return false;
  const t = token.trim();
  if (t.length < 1 || t.length > 255) return false;
  if (/\s/.test(t)) return false;
  return TOKEN_PREFIXES.some((p) => t.startsWith(p));
}

// ---- 投稿 ----

function safeGithubUrl(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '' || /\s/.test(s) || !/^https:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && u.hostname === 'github.com' && !u.username && !u.password ? s : null;
  } catch {
    return null;
  }
}

function statusMessage(status) {
  switch (status) {
    case 401:
      return 'トークンが無効か期限切れです。設定し直してください(401)';
    case 403:
      return 'このトークンにはコメントを書く権限がありません。Issues: Read and write を確認してください(403)';
    case 404:
      return 'Issue が見つからないか、トークンの対象リポジトリに含まれていません(404)';
    case 422:
      return 'GitHub がコメント内容を受け付けませんでした。Issue が閉じられていないか確認してください(422)';
    case 429:
      return 'GitHub のリクエスト上限に達しました。しばらく待ってからやり直してください(429)';
    default:
      return `GitHub への投稿に失敗しました(HTTP ${Number.isFinite(status) ? status : '不明'})`;
  }
}

export async function postDecisionComment({ fetchImpl, token, decision, verdict, choiceKey, reason } = {}) {
  const ref = parseIssueRef(decision);
  if (!ref) return { ok: false, message: '投稿先の Issue を特定できません' };
  if (!validateToken(token)) return { ok: false, message: 'トークンの形式が正しくありません' };
  if (typeof fetchImpl !== 'function') return { ok: false, message: '通信機能が利用できません' };
  const secret = token.trim();
  let body;
  try {
    body = buildCommentBody(decision, verdict, choiceKey, reason);
  } catch {
    return { ok: false, message: '決定の種類が正しくありません' };
  }
  const url = `https://api.github.com/repos/${ref.repo}/issues/${ref.number}/comments`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    });
  } catch {
    return { ok: false, message: 'GitHub に接続できませんでした。ネットワークを確認してください' };
  }
  const status = res && typeof res.status === 'number' ? res.status : NaN;
  if (status === 201) {
    let htmlUrl = null;
    try {
      const data = await res.json();
      htmlUrl = isObject(data) ? safeGithubUrl(data.html_url) : null;
    } catch {
      htmlUrl = null;
    }
    if (htmlUrl && htmlUrl.includes(secret)) htmlUrl = null;
    return { ok: true, url: htmlUrl };
  }
  // エラー本文は読まない(トークンが紛れても返り値に出さない)。固定の日本語メッセージのみ。
  return { ok: false, status: Number.isFinite(status) ? status : undefined, message: statusMessage(status) };
}

// ---- 案(options)の UI 用ヘルパー ----

function detailText(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/** options(文字列/オブジェクト混在可)を {key,label,recommended,cost,effect,risk} に正規化。 */
export function normalizeOptions(decision) {
  const list = isObject(decision) && Array.isArray(decision.options) ? decision.options : [];
  const recKey = isObject(decision) ? nonEmptyString(decision.recommended_key) : null;
  const out = [];
  for (const o of list) {
    if (typeof o === 'string') {
      const s = o.trim();
      if (s === '') continue;
      const key = s.length <= 2 ? s : null;
      out.push({ key, label: s, recommended: key !== null && key === recKey, cost: null, effect: null, risk: null });
    } else if (isObject(o)) {
      const rawLabel = nonEmptyString(o.label);
      const m = rawLabel ? /案([A-Z])/.exec(rawLabel) : null;
      const key = nonEmptyString(o.key) || (m ? m[1] : null);
      const label = rawLabel ? rawLabel.replace(/\s*推奨\s*$/, '').trim() : key ? `案${key}` : null;
      const recommended = o.recommended === true || (rawLabel !== null && rawLabel.includes('推奨')) || (key !== null && key === recKey);
      if (!label && !key) continue;
      out.push({
        key,
        label: label || key,
        recommended,
        cost: detailText(o.cost),
        effect: detailText(o.effect),
        risk: detailText(o.risk),
      });
    }
  }
  return out;
}

/** 案 1 つの表示用: {title, rows:[{name,text}]}。null の項目は rows に含めない。 */
export function describeOption(opt) {
  const o = isObject(opt) ? opt : {};
  const title = detailText(o.label) || (detailText(o.key) ? `案${o.key}` : '案');
  const rows = [];
  const cost = detailText(o.cost);
  const effect = detailText(o.effect);
  const risk = detailText(o.risk);
  if (cost) rows.push({ name: '費用', text: cost });
  if (effect) rows.push({ name: '効果', text: effect });
  if (risk) rows.push({ name: 'リスク', text: risk });
  return { title, rows };
}

/** 1 つでも cost/effect/risk があれば true。 */
export function hasOptionDetails(decision) {
  return normalizeOptions(decision).some((o) => o.cost || o.effect || o.risk);
}

/** 推奨案を 1 つ返す(recommended_key 一致 → recommended:true → 先頭)。無ければ null。 */
export function recommendedOption(decision) {
  const options = normalizeOptions(decision);
  if (options.length === 0) return null;
  const key = isObject(decision) ? nonEmptyString(decision.recommended_key) : null;
  if (key !== null) {
    const hit = options.find((o) => o.key === key);
    if (hit) return hit;
  }
  return options.find((o) => o.recommended) || options[0] || null;
}

// ---- 判断コメント中継(relay) ----

const RELAY_SALT = 'hq-decision-relay-v1';
const RELAY_ITERATIONS = 100000;
const RELAY_MSG_DEFAULT = '送信できませんでした。GitHub の Issue から返信してください';

/** PBKDF2-HMAC-SHA256(100000回, 32バイト) → 小文字 hex 64桁。relay/worker.js と同一の導出。 */
export async function deriveRelayKey(passphrase, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error('暗号機能が利用できません');
  const enc = new TextEncoder();
  const keyMaterial = await subtle.importKey('raw', enc.encode(String(passphrase)), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(RELAY_SALT), iterations: RELAY_ITERATIONS },
    keyMaterial,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 中継が使える条件: relayUrl が https:// で始まり passphrase が非空。 */
export function isRelayUsable(relayUrl, passphrase) {
  return typeof relayUrl === 'string' && relayUrl.startsWith('https://') &&
    typeof passphrase === 'string' && passphrase.length > 0;
}

/** 中継 Worker へ決定コメントを POST。パスフレーズ・key は戻り値/メッセージに含めない。 */
export async function postViaRelay({ relayUrl, passphrase, issueRef, body, fetchImpl, subtle } = {}) {
  if (!isRelayUsable(relayUrl, passphrase)) return { ok: false, message: '中継が設定されていません' };
  if (!isObject(issueRef) || typeof issueRef.repo !== 'string' || toIssueNumber(issueRef.number) === null) {
    return { ok: false, message: '投稿先の Issue を特定できません' };
  }
  if (typeof fetchImpl !== 'function') return { ok: false, message: '通信機能が利用できません' };
  let key;
  try {
    key = await deriveRelayKey(passphrase, subtle);
  } catch {
    return { ok: false, message: RELAY_MSG_DEFAULT };
  }
  let res;
  try {
    res = await fetchImpl(`${relayUrl.replace(/\/+$/, '')}/decide`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue_repo: issueRef.repo, issue_number: issueRef.number, body }),
    });
  } catch {
    return { ok: false, message: RELAY_MSG_DEFAULT };
  }
  if (res && res.ok) {
    let url = null;
    try {
      const data = await res.json();
      if (data && typeof data.url === 'string' && data.url.startsWith('https://github.com/')) url = data.url;
    } catch {
      url = null;
    }
    return { ok: true, url };
  }
  const status = res && typeof res.status === 'number' ? res.status : 0;
  if (status === 401) return { ok: false, status, message: '認証に失敗しました。ロックして入り直してください' };
  if (status === 429) return { ok: false, status, message: 'しばらくしてからもう一度お試しください' };
  return { ok: false, status, message: RELAY_MSG_DEFAULT };
}
