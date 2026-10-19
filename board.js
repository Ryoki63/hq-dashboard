// dashboard/board.js — 判断かんばん(DOM 部)
//
// 純粋ロジックは board-logic.js(re-export)。ここは描画・ドラッグ&ドロップ・
// 確認ダイアログ・トークン設定帯・「反映待ち」の暫定表示だけを持つ。
// 安全方針: innerHTML 禁止(textContent / createElement のみ)、style 属性・<style> 禁止(CSP)。

import {
  classifyDecisions,
  buildCommentBody,
  parseIssueRef,
  validateToken,
  postDecisionComment,
  normalizeOptions,
  describeOption,
  hasOptionDetails,
  remainingLabel,
  deadlineInstant,
} from './board-logic.js';
import { safeHref, formatDateJa, formatDateTimeJa } from './lib.js';

export * from './board-logic.js';

export const TOKEN_KEY = 'hq.dashboard.ghtoken';
export const PENDING_KEY = 'hq.dashboard.pending-decisions';

const PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const NO_DETAIL_TEXT = '案の詳細が未取得です。Issue を開いて確認してください';
const TOKEN_GUIDE =
  '必要なトークン: Fine-grained PAT、対象リポジトリは solo-company だけ、権限は Issues: Read and write のみ。' +
  'トークンはこのタブのセッション中だけ保持し、画面には再表示しません。';

const COLUMNS = [
  { key: 'pending', title: '判断待ち', hint: 'ここからドラッグして決めます', verdict: null },
  { key: 'approved', title: '承認', hint: '決定済み・実行へ', verdict: 'approve' },
  { key: 'hold', title: '保留', hint: '期限切れ(無返答時の扱いが適用中)または保留', verdict: 'hold' },
  { key: 'rejected', title: '見送り', hint: '実行しない', verdict: 'reject' },
];
const VERDICT_COLUMN = { approve: 'approved', hold: 'hold', reject: 'rejected' };
const VERDICT_NAME = { approve: '承認', hold: '保留', reject: '見送り' };
const VERDICT_VERB = { approve: '承認する', hold: '保留する', reject: '見送る' };

// ---------- 小さな DOM ヘルパー ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function attr(node, attrs) {
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function isText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function stripRecommended(title) {
  return String(title ?? '')
    .replace(/\s*推奨\s*$/, '')
    .trim();
}

// ---------- ctx.storage(例外は握りつぶす) ----------

function makeStore(storage) {
  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  return {
    get: (key) => safe(() => (storage ? storage.get(key) : null), null),
    set: (key, value) => safe(() => (storage ? (storage.set(key, value), true) : false), false),
    remove: (key) => safe(() => (storage ? (storage.remove(key), true) : false), false),
  };
}

function loadPending(store) {
  const raw = store.get(PENDING_KEY);
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function savePending(store, map) {
  if (Object.keys(map).length === 0) store.remove(PENDING_KEY);
  else store.set(PENDING_KEY, JSON.stringify(map));
}

// ledger が決定済みになった / 古すぎる暫定エントリを掃除する。
function prunePending(store, decisions, now) {
  const map = loadPending(store);
  const byId = new Map();
  for (const d of decisions) if (d && typeof d.id === 'string') byId.set(d.id, d);
  let changed = false;
  for (const [id, entry] of Object.entries(map)) {
    const decision = byId.get(id);
    const at = Number(entry && entry.at);
    const stale = Number.isFinite(at) && now - at > PENDING_MAX_AGE_MS;
    const valid = entry && VERDICT_COLUMN[entry.verdict];
    if (!valid || stale || (decision && decision.status !== 'pending')) {
      delete map[id];
      changed = true;
    }
  }
  if (changed) savePending(store, map);
  return map;
}

function urgency(deadline, now) {
  const at = deadlineInstant(deadline);
  if (at === null) return 'none';
  if (at <= now) return 'overdue';
  return at - now < 24 * 60 * 60 * 1000 ? 'urgent' : 'normal';
}

// ---------- 案の描画 ----------

function optionClass(opt, index) {
  const letter = isText(opt.key) && /^[A-Za-z]$/.test(opt.key) ? opt.key.toLowerCase() : null;
  return `board-option board-option--${letter ?? `n${index % 3}`}`;
}

function renderOptionBody(opt) {
  const info = describeOption(opt);
  const dl = el('dl', 'board-option-rows');
  if (info.rows.length === 0) {
    return el('p', 'board-option-empty', NO_DETAIL_TEXT);
  }
  for (const row of info.rows) {
    const item = el('div', `board-option-row board-option-row--${rowKind(row.name)}`);
    item.append(el('dt', 'board-option-name', row.name), el('dd', 'board-option-text', row.text));
    dl.append(item);
  }
  return dl;
}

function rowKind(name) {
  if (name === '費用') return 'cost';
  if (name === '効果') return 'effect';
  return 'risk';
}

function renderOptionList(decision) {
  const options = normalizeOptions(decision);
  const wrap = el('div', 'board-options');
  if (options.length === 0 || !hasOptionDetails(decision)) {
    wrap.append(el('p', 'board-options-missing', NO_DETAIL_TEXT));
    // 記号だけ(A/B/C)は出さない。意味のある文字列だけ補足する。
    const labels = options
      .map((o) => (typeof o.label === 'string' ? o.label.trim() : ''))
      .filter((s) => s.length > 2 && !/^案?[A-Za-z]$/.test(s));
    if (labels.length > 0) wrap.append(el('p', 'board-options-labels', `案の名前: ${labels.join(' / ')}`));
    return wrap;
  }
  wrap.append(el('h4', 'board-options-title', '案の比較(費用・効果・リスク)'));
  options.forEach((opt, index) => {
    const info = describeOption(opt);
    const card = el('div', optionClass(opt, index));
    if (isText(opt.key)) card.setAttribute('data-option-key', opt.key);
    const head = el('div', 'board-option-head');
    head.append(el('span', 'board-option-title', stripRecommended(info.title) || '案'));
    if (opt.recommended) head.append(el('span', 'board-badge board-badge--recommended', '推奨'));
    card.append(head, renderOptionBody(opt));
    wrap.append(card);
  });
  return wrap;
}

// ---------- メイン ----------

export function renderBoard(host, decisions, ctx = {}) {
  const store = makeStore(ctx.storage);
  const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
  const list = Array.isArray(decisions) ? decisions.filter((d) => d && typeof d === 'object') : [];
  const state = {
    notice: null, // {kind:'ok'|'error', text}
    openDialog: null, // {overlay, close}
    dragId: null,
    pending: prunePending(store, list, now),
  };

  const root = el('section', 'board');
  root.setAttribute('aria-label', '判断かんばん');

  function tokenValue() {
    const t = store.get(TOKEN_KEY);
    return typeof t === 'string' && t !== '' ? t : null;
  }

  function closeDialog() {
    if (state.openDialog) state.openDialog.close();
  }

  function draw() {
    closeDialog();
    const buckets = classifyDecisions(list, now);
    const columns = { pending: [], approved: [], hold: [], rejected: [] };
    for (const key of Object.keys(columns)) {
      for (const d of (buckets && buckets[key]) || []) columns[key].push({ decision: d, awaiting: null });
    }
    // 投稿済み(反映待ち)は該当列へ移す。
    for (const key of ['pending', 'hold']) {
      const keep = [];
      for (const item of columns[key]) {
        const entry = state.pending[item.decision.id];
        const target = entry ? VERDICT_COLUMN[entry.verdict] : null;
        if (target && item.decision.status === 'pending') {
          columns[target].push({ decision: item.decision, awaiting: entry });
        } else {
          keep.push(item);
        }
      }
      columns[key] = keep;
    }

    const children = [renderTokenBar(), renderNotice()];
    const grid = el('div', 'board-columns');
    for (const col of COLUMNS) grid.append(renderColumn(col, columns[col.key]));
    children.push(grid);
    root.replaceChildren(...children);
  }

  // ----- 通知 -----
  let noticeNode = null;
  function renderNotice() {
    noticeNode = el('p', 'board-notice');
    noticeNode.setAttribute('role', 'status');
    applyNotice();
    return noticeNode;
  }
  function applyNotice() {
    if (!noticeNode) return;
    const n = state.notice;
    noticeNode.textContent = n ? n.text : '';
    noticeNode.className = n ? `board-notice board-notice--${n.kind}` : 'board-notice board-notice--empty';
  }
  function setNotice(kind, text) {
    state.notice = text ? { kind, text } : null;
    applyNotice();
  }

  // ----- トークン帯 -----
  function renderTokenBar() {
    const bar = el('div', 'board-token');
    const hasToken = tokenValue() !== null;
    const status = el(
      'p',
      `board-token-status board-token-status--${hasToken ? 'set' : 'unset'}`,
      hasToken
        ? '接続: トークン設定済み(確認後、GitHub へ直接投稿します)'
        : 'トークン未設定: 投稿の代わりに GitHub のコメント画面を開きます',
    );
    const form = el('div', 'board-token-form');
    const label = el('label', 'board-token-label', 'GitHub トークン');
    const input = el('input', 'board-token-input');
    attr(input, { type: 'password', autocomplete: 'off', spellcheck: 'false', name: 'gh-token', id: 'board-token-input' });
    label.setAttribute('for', 'board-token-input');
    input.setAttribute('aria-label', 'GitHub トークン(Fine-grained PAT)');
    input.setAttribute('placeholder', hasToken ? '(設定済み・再表示しません)' : 'github_pat_… を貼り付け');
    const save = el('button', 'board-btn board-btn--primary', '保存');
    attr(save, { type: 'button', 'aria-label': 'トークンを保存' });
    save.addEventListener('click', () => {
      const value = typeof input.value === 'string' ? input.value.trim() : '';
      if (!validateToken(value)) {
        setNotice('error', 'トークンの形式が正しくありません(github_pat_ または ghp_ で始まる値を貼り付けてください)。');
        return;
      }
      if (!store.set(TOKEN_KEY, value)) {
        setNotice('error', 'トークンをこのブラウザに保存できませんでした。');
        return;
      }
      input.value = '';
      state.notice = { kind: 'ok', text: 'トークンを保存しました(このタブのセッション中だけ有効)。' };
      draw();
    });
    form.append(label, input, save);
    if (hasToken) {
      const clear = el('button', 'board-btn', 'クリア');
      attr(clear, { type: 'button', 'aria-label': 'トークンを消去' });
      clear.addEventListener('click', () => {
        store.remove(TOKEN_KEY);
        state.notice = { kind: 'ok', text: 'トークンを消去しました。' };
        draw();
      });
      form.append(clear);
    }
    bar.append(status, form, el('p', 'board-token-guide', TOKEN_GUIDE));
    return bar;
  }

  // ----- 列・カード -----
  function renderColumn(col, items) {
    const section = el('section', `board-column board-column--${col.key}`);
    section.setAttribute('data-column', col.key);
    section.setAttribute('aria-label', `${col.title}(${items.length}件)`);
    const head = el('header', 'board-column-head');
    head.append(el('h3', 'board-column-title', col.title), el('span', 'board-column-count', String(items.length)));
    section.append(head, el('p', 'board-column-hint', col.hint));
    const body = el('div', 'board-column-body');
    if (items.length === 0) body.append(el('p', 'board-empty', '該当なし'));
    for (const item of items) body.append(renderCard(col, item));
    section.append(body);

    if (col.verdict) {
      section.addEventListener('dragover', (e) => {
        if (!state.dragId) return;
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        if (e && e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        section.classList.add('board-column--over');
      });
      section.addEventListener('dragleave', (e) => {
        if (e && e.relatedTarget && typeof section.contains === 'function' && section.contains(e.relatedTarget)) return;
        section.classList.remove('board-column--over');
      });
      section.addEventListener('drop', (e) => {
        if (e && typeof e.preventDefault === 'function') e.preventDefault();
        section.classList.remove('board-column--over');
        let id = state.dragId;
        if (!id && e && e.dataTransfer && typeof e.dataTransfer.getData === 'function') id = e.dataTransfer.getData('text/plain');
        state.dragId = null;
        const decision = list.find((d) => d.id === id);
        if (decision && decision.status === 'pending' && !state.pending[decision.id]) openDialog(decision, col.verdict);
      });
    }
    return section;
  }

  function renderCard(col, item) {
    const d = item.decision;
    const awaiting = item.awaiting;
    const decided = d.status === 'approved' || d.status === 'rejected';
    const actionable = d.status === 'pending' && !awaiting;
    const draggable = col.key === 'pending' && actionable;

    const card = el('article', `board-card board-card--${col.key}`);
    card.setAttribute('data-id', String(d.id ?? ''));
    if (draggable) {
      card.classList.add('board-card--draggable');
      card.setAttribute('draggable', 'true');
      card.addEventListener('dragstart', (e) => {
        state.dragId = d.id;
        card.classList.add('board-card--dragging');
        if (e && e.dataTransfer) {
          try {
            e.dataTransfer.setData('text/plain', String(d.id));
            e.dataTransfer.effectAllowed = 'move';
          } catch {
            /* 無視 */
          }
        }
        root.classList.add('board--dragging');
      });
      card.addEventListener('dragend', () => {
        state.dragId = null;
        card.classList.remove('board-card--dragging');
        root.classList.remove('board--dragging');
      });
    } else {
      card.setAttribute('aria-readonly', 'true');
    }

    const head = el('header', 'board-card-head');
    head.append(el('span', 'board-card-id', String(d.id ?? '(ID なし)')));
    if (awaiting) head.append(el('span', 'board-badge board-badge--awaiting', '反映待ち'));
    card.append(head, el('h4', 'board-card-title', isText(d.title) ? d.title : '(題名なし)'));

    if (isText(d.question)) {
      const q = el('p', 'board-card-question');
      q.append(el('span', 'board-label', '問い'), document.createTextNode(d.question));
      card.append(q);
    }

    const meta = el('dl', 'board-meta');
    const metaRow = (name, value, cls) => {
      const row = el('div', 'board-meta-row');
      row.append(el('dt', 'board-meta-name', name), el('dd', cls ? `board-meta-text ${cls}` : 'board-meta-text', value));
      meta.append(row);
    };
    if (d.status === 'pending') {
      const level = urgency(d.deadline, now);
      const when = isText(d.deadline) ? `${formatDateJa(d.deadline)}(${remainingLabel(d.deadline, now)})` : '期限なし';
      metaRow('期限', when, `board-deadline board-deadline--${level}`);
      metaRow('無返答の場合', isText(d.default_if_no_reply) ? d.default_if_no_reply : '未設定');
    } else {
      metaRow('決定', `${d.status === 'approved' ? '承認' : '見送り'}${isText(d.choice) ? `(${d.choice})` : ''}`);
      if (isText(d.decided_at)) metaRow('決定日時', formatDateTimeJa(d.decided_at));
    }
    card.append(meta);

    if (awaiting) {
      const name = VERDICT_NAME[awaiting.verdict] ?? '決定';
      const choice = awaiting.verdict === 'approve' && isText(awaiting.choiceKey) ? `(案${awaiting.choiceKey})` : '';
      card.append(
        el('p', 'board-awaiting-note', `あなたの決定「${name}${choice}」を投稿しました。HQ が次回の更新で反映します。`),
      );
    }

    card.append(renderOptionList(d));
    if (isText(d.recommendation)) {
      const rec = el('p', 'board-card-recommendation');
      rec.append(el('span', 'board-label', 'HQ の推奨'), document.createTextNode(d.recommendation));
      card.append(rec);
    }

    const foot = el('footer', 'board-card-foot');
    const href = safeHref(d.issue_url);
    if (href) {
      const link = el('a', 'board-link', d.issue_number ? `Issue #${d.issue_number} を開く` : 'Issue を開く');
      attr(link, { href, target: '_blank', rel: 'noopener noreferrer' });
      foot.append(link);
    } else {
      foot.append(el('span', 'board-link board-link--none', 'Issue リンクなし'));
    }
    if (actionable) {
      const actions = el('div', 'board-actions');
      for (const verdict of ['approve', 'hold', 'reject']) {
        const btn = el('button', `board-btn board-btn--${verdict}`, VERDICT_VERB[verdict]);
        attr(btn, { type: 'button', 'aria-label': `${d.id} を${VERDICT_VERB[verdict]}` });
        btn.addEventListener('click', () => openDialog(d, verdict, btn));
        actions.append(btn);
      }
      foot.append(actions);
    } else if (decided) {
      foot.append(el('span', 'board-readonly', '読み取り専用(台帳が正本)'));
    }
    card.append(foot);
    return card;
  }

  // ----- 確認ダイアログ -----
  function openDialog(decision, verdict, opener) {
    closeDialog();
    const previousFocus = opener || (typeof document !== 'undefined' ? document.activeElement : null);
    const options = normalizeOptions(decision).filter((o) => isText(o.key));
    const detailed = hasOptionDetails(decision);
    let selectedKey = null;
    if (verdict === 'approve' && options.length > 0) {
      const rec = options.find((o) => o.key === decision.recommended_key) || options.find((o) => o.recommended);
      selectedKey = (rec || options[0]).key;
    }
    let busy = false;
    let closed = false;

    const overlay = el('div', 'board-overlay');
    const dialog = el('div', 'board-dialog');
    const titleId = `board-dialog-title-${String(decision.id ?? 'x').replace(/[^A-Za-z0-9_-]/g, '')}`;
    attr(dialog, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
    dialog.append(
      attr(el('h3', 'board-dialog-title', `${decision.id ?? ''} を${VERDICT_VERB[verdict]}`), { id: titleId }),
      el('p', 'board-dialog-sub', isText(decision.title) ? decision.title : ''),
    );
    if (isText(decision.question)) dialog.append(el('p', 'board-dialog-question', `問い: ${decision.question}`));

    const focusables = [];

    if (verdict === 'approve') {
      const fieldset = el('fieldset', 'board-choices');
      fieldset.append(el('legend', 'board-choices-legend', 'どの案で承認しますか'));
      if (options.length === 0) {
        fieldset.append(el('p', 'board-options-missing', `${NO_DETAIL_TEXT}。案を指定せずに承認します。`));
      }
      options.forEach((opt, index) => {
        const info = describeOption(opt);
        const labelEl = el('label', optionClass(opt, index).replace('board-option ', 'board-choice board-option '));
        const radio = el('input', 'board-choice-radio');
        attr(radio, { type: 'radio', name: 'board-choice', value: opt.key });
        radio.checked = opt.key === selectedKey;
        if (radio.checked) radio.setAttribute('checked', 'checked');
        radio.addEventListener('change', () => {
          selectedKey = opt.key;
        });
        const body = el('span', 'board-choice-body');
        const head = el('span', 'board-option-head');
        head.append(el('span', 'board-option-title', stripRecommended(info.title) || `案${opt.key}`));
        if (opt.recommended) head.append(el('span', 'board-badge board-badge--recommended', '推奨'));
        body.append(head);
        if (info.rows.length === 0) {
          body.append(el('span', 'board-option-empty', detailed ? '詳細の記載なし' : NO_DETAIL_TEXT));
        } else {
          const dl = el('dl', 'board-option-rows');
          for (const row of info.rows) {
            const item = el('div', `board-option-row board-option-row--${rowKind(row.name)}`);
            item.append(el('dt', 'board-option-name', row.name), el('dd', 'board-option-text', row.text));
            dl.append(item);
          }
          body.append(dl);
        }
        labelEl.append(radio, body);
        fieldset.append(labelEl);
        focusables.push(radio);
      });
      dialog.append(fieldset);
    } else {
      dialog.append(
        el(
          'p',
          'board-dialog-note',
          verdict === 'hold'
            ? '保留します。新しい支出・約束はせず、判断を後に回します。'
            : 'この件は見送ります。実行しません。',
        ),
      );
    }

    const reasonLabel = el('label', 'board-reason-label', '理由(任意)');
    const reason = el('textarea', 'board-reason');
    attr(reason, { rows: '3', maxlength: '1000', id: 'board-reason', 'aria-label': '理由(任意)' });
    reasonLabel.setAttribute('for', 'board-reason');
    dialog.append(reasonLabel, reason);
    focusables.push(reason);

    const direct = tokenValue() !== null;
    dialog.append(
      el(
        'p',
        'board-dialog-mode',
        direct
          ? '確認すると、このコメントを GitHub の Issue に直接投稿します。'
          : 'トークン未設定のため、確認すると GitHub のコメント画面を新しいタブで開き、本文をコピーします。',
      ),
    );

    const errorBox = el('p', 'board-dialog-error');
    errorBox.setAttribute('role', 'alert');
    dialog.append(errorBox);

    const buttons = el('div', 'board-dialog-buttons');
    const confirm = el(
      'button',
      `board-btn board-btn--primary board-btn--${verdict}`,
      direct ? 'この内容で GitHub に投稿する' : 'GitHub のコメント画面を開く',
    );
    attr(confirm, { type: 'button', 'aria-label': `${decision.id ?? ''} を${VERDICT_NAME[verdict]}として確定する` });
    const cancel = el('button', 'board-btn', 'キャンセル');
    attr(cancel, { type: 'button', 'aria-label': 'キャンセルして閉じる' });
    buttons.append(cancel, confirm);
    dialog.append(buttons);
    focusables.push(cancel, confirm);

    function close() {
      if (closed) return;
      closed = true;
      if (state.openDialog && state.openDialog.overlay === overlay) state.openDialog = null;
      root.replaceChildren(...Array.from(root.children).filter((c) => c !== overlay));
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try {
          previousFocus.focus();
        } catch {
          /* 無視 */
        }
      }
    }

    cancel.addEventListener('click', () => {
      if (!busy) close();
    });
    overlay.addEventListener('click', (e) => {
      if (e && e.target === overlay && !busy) close();
    });
    overlay.addEventListener('keydown', (e) => {
      if (!e) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (!busy) close();
        return;
      }
      if (e.key === 'Tab' && focusables.length > 0) {
        const active = typeof document !== 'undefined' ? document.activeElement : null;
        const idx = focusables.indexOf(active);
        const last = focusables.length - 1;
        if (e.shiftKey && idx <= 0) {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          focusables[last].focus();
        } else if (!e.shiftKey && idx === last) {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          focusables[0].focus();
        }
      }
    });

    function setBusy(value) {
      busy = value;
      confirm.disabled = value;
      cancel.disabled = value;
      reason.disabled = value;
      confirm.textContent = value
        ? '送信中…'
        : direct
          ? 'この内容で GitHub に投稿する'
          : 'GitHub のコメント画面を開く';
    }

    confirm.addEventListener('click', async () => {
      if (busy) return; // 二重送信防止
      setBusy(true);
      errorBox.textContent = '';
      const reasonText = typeof reason.value === 'string' ? reason.value.trim() : '';
      const choiceKey = verdict === 'approve' ? selectedKey : null;
      try {
        const token = tokenValue();
        if (token !== null) {
          if (!validateToken(token)) {
            errorBox.textContent = '保存済みのトークンの形式が正しくありません。クリアして設定し直してください。';
            setBusy(false);
            return;
          }
          const result = await postDecisionComment({
            fetchImpl: ctx.fetchImpl,
            token,
            decision,
            verdict,
            choiceKey,
            reason: reasonText,
          });
          if (!result || !result.ok) {
            const status = result && result.status ? `(HTTP ${result.status})` : '';
            errorBox.textContent = `投稿に失敗しました${status}: ${(result && result.message) || '原因不明のエラー'}`;
            setBusy(false);
            return;
          }
          state.pending[decision.id] = { verdict, choiceKey, at: now };
          savePending(store, state.pending);
          state.notice = {
            kind: 'ok',
            text: `${decision.id} を「${VERDICT_NAME[verdict]}」として投稿しました。HQ の次回更新まで「反映待ち」で表示します。`,
          };
          closed = false; // draw() 内の closeDialog 経由で close() が呼ばれる
          draw();
          if (typeof ctx.onChange === 'function') ctx.onChange();
          return;
        }
        // トークン未設定: コメント画面を開き、本文をコピーする。
        const ref = parseIssueRef(decision);
        if (!ref) {
          errorBox.textContent = 'この判断の Issue を特定できませんでした(対象は Ryoki63/solo-company のみ)。';
          setBusy(false);
          return;
        }
        const body = buildCommentBody(decision, verdict, choiceKey, reasonText);
        const url = `https://github.com/${ref.repo}/issues/${ref.number}#issuecomment-new`;
        let copied = false;
        try {
          const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
          if (clip && typeof clip.writeText === 'function') {
            await clip.writeText(body);
            copied = true;
          }
        } catch {
          copied = false;
        }
        try {
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener');
        } catch {
          /* ポップアップ不可は通知で補う */
        }
        state.notice = {
          kind: 'ok',
          text: copied
            ? 'GitHub のコメント画面を開きました。コピー済みの本文を貼り付けて投稿してください(まだ投稿されていません)。'
            : 'GitHub のコメント画面を開きました。本文のコピーに失敗したため、手入力で投稿してください(まだ投稿されていません)。',
        };
        closed = false;
        closeDialog();
        applyNotice();
      } catch (err) {
        const detail = err && typeof err.message === 'string' && !/token|github_pat|ghp_/i.test(err.message) ? `(${err.message})` : '';
        errorBox.textContent = `予期しないエラーが起きました${detail}。もう一度お試しください。`;
        setBusy(false);
      }
    });

    overlay.append(dialog);
    root.append(overlay);
    state.openDialog = { overlay, close };
    const first = focusables[0];
    if (first && typeof first.focus === 'function') first.focus();
  }

  host.replaceChildren(root);
  draw();
  return root;
}
