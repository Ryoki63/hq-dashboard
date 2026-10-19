// dashboard/app.js — オーナー専用ダッシュボードの描画（ES module）
//
// 方針:
//  - データは必ず textContent / DOM 生成で描く（innerHTML にデータを入れない）。
//  - innerHTML は使わない。Markdown も lib.js のパース結果から要素を作る。
//  - リンクは https:// のみ、画像は data:image/png;base64, のみ（lib.js で検証）。
//  - パスフレーズは sessionStorage だけに置く（タブを閉じると消える）。

import { DecryptionError, decryptEnvelope } from './crypto.js';
import { renderBoard, TOKEN_KEY } from './board.js';
import { enhance as enhanceMotion, disable as disableMotion } from './motion.js';
import { initTheme } from './theme.js';
import {
  renderKpiTiles,
  renderPhaseSection,
  renderAgentsSection,
  renderModelsSection,
  renderFinanceSection,
} from './views.js';
import {
  deadlineLevel,
  deptLabel,
  formatDateJa,
  formatDateTimeJa,
  formatDaysUntil,
  formatElapsed,
  formatKpi,
  formatRemaining,
  formatTimeJa,
  formatUsd,
  ganttSpan,
  heartbeatLevel,
  isSafeImage,
  numericEntries,
  parseMarkdown,
  percent,
  phaseLabel,
  roleLabel,
  safeHref,
  statusLabel,
  statusTone,
  topN,
} from './lib.js';

const PASS_STORAGE_KEY = 'consilium.dashboard.passphrase';
const CLOCK_INTERVAL_MS = 30_000;
const TASKS_PER_COLUMN = 5;
const CLOCK_HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const GRID_HOURS = [0, 6, 12, 18, 24];
const DEPT_ORDER = ['pmo', 'product', 'ux', 'eng', 'qa', 'mkt', 'ops', 'fin'];
const TASK_COLUMNS = [
  ['ready', '着手待ち'],
  ['in_progress', '作業中'],
  ['review', 'レビュー待ち'],
  ['waiting', '返答待ち'],
  ['blocked', 'ブロック'],
  ['done_today', '本日完了'],
];
/** 部署の表示順（未知の部署は末尾）。 */
function deptRank(dept) {
  const index = DEPT_ORDER.indexOf(dept);
  return index === -1 ? DEPT_ORDER.length : index;
}

const KPI_LABELS = {
  dau: 'DAU',
  wau: 'WAU',
  mau: 'MAU',
  installs: 'インストール',
  retention_d1: '翌日継続率',
  retention_d7: '7日継続率',
  revenue_usd: '売上',
  mrr_usd: 'MRR',
  release_count: 'リリース回数',
  crash_rate: 'クラッシュ率',
};

const state = {
  data: null,
  demo: false,
  clock: 0,
};

// ---------------------------------------------------------------------------
// DOM ヘルパー
// ---------------------------------------------------------------------------

function $(selector) {
  return document.querySelector(selector);
}

function el(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value !== null && value !== undefined) node.setAttribute(name, String(value));
    }
  }
  if (Array.isArray(options.children)) {
    for (const child of options.children) {
      if (child) node.append(child);
    }
  }
  return node;
}

function clear(node) {
  if (!node) return;
  node.replaceChildren();
}

function span(className, text) {
  return el('span', { class: className, text });
}

function emptyState(message) {
  return el('p', { class: 'empty', text: message });
}

function externalAnchor(href, label, className) {
  return el('a', {
    class: className,
    text: label,
    attrs: { href, target: '_blank', rel: 'noopener noreferrer' },
  });
}

// ---------------------------------------------------------------------------
// 共通パーツ
// ---------------------------------------------------------------------------

function panel(id, title, note) {
  const section = el('section', {
    class: 'panel',
    attrs: { id: `${id}-panel`, 'aria-labelledby': `${id}-title` },
  });
  const head = el('div', { class: 'panel-head' });
  head.append(el('h2', { class: 'panel-title', text: title, attrs: { id: `${id}-title` } }));
  if (note) head.append(el('p', { class: 'panel-note', text: note }));
  section.append(head);
  return section;
}

function appendImage(container, raw, alt) {
  if (!isSafeImage(raw)) {
    container.append(el('p', { class: 'img-missing', text: '画像未生成' }));
    return;
  }
  const figure = el('figure', { class: 'figure' });
  figure.append(
    el('img', {
      class: 'figure-img',
      attrs: { src: raw, alt, loading: 'lazy', decoding: 'async' },
    }),
  );
  figure.append(el('figcaption', { class: 'figure-cap', text: alt }));
  container.append(figure);
}

function metaList(rows) {
  const dl = el('dl', { class: 'meta-list' });
  for (const [label, value] of rows) {
    if (value === null || value === undefined) continue;
    dl.append(el('dt', { text: label }));
    dl.append(el('dd', { text: value }));
  }
  return dl;
}

function badgeFor(status) {
  return span(`badge badge--${statusTone(status)}`, statusLabel(status));
}

function optionText(option) {
  if (typeof option === 'string') return option.trim();
  if (option && typeof option === 'object') {
    for (const key of ['label', 'title', 'summary', 'text']) {
      if (typeof option[key] === 'string' && option[key].trim() !== '') return option[key].trim();
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// ヘッダー
// ---------------------------------------------------------------------------

function renderHeader(data) {
  const host = $('#header-meta');
  if (!host) return;
  clear(host);
  const generated = data.generated_at;
  const elapsedItem = el('span', { class: 'header-item' });
  elapsedItem.append(span('header-label', '生成'));
  elapsedItem.append(el('strong', { class: 'header-value', text: formatElapsed(generated) }));
  elapsedItem.append(span('header-label', `(${formatDateTimeJa(generated)})`));
  host.append(elapsedItem);

  const sources = data.sources;
  if (sources && typeof sources === 'object' && !Array.isArray(sources)) {
    const failed = Object.entries(sources).filter(
      ([, value]) => typeof value === 'string' && /^error/i.test(value.trim()),
    ).length;
    host.append(
      el('span', {
        class: failed > 0 ? 'header-item header-item--warn' : 'header-item',
        text: failed > 0 ? `データ源エラー ${failed}件` : 'データ源 正常',
      }),
    );
  }

  if (state.demo) {
    host.append(span('badge badge--gold', 'サンプル（平文）'));
    host.append(
      el('a', {
        class: 'header-item',
        text: '通常モードへ',
        attrs: { href: location.pathname },
      }),
    );
  }
}

function startClock() {
  stopClock();
  state.clock = window.setInterval(() => {
    if (state.data) renderHeader(state.data);
  }, CLOCK_INTERVAL_MS);
}

function stopClock() {
  if (state.clock) {
    window.clearInterval(state.clock);
    state.clock = 0;
  }
}

// ---------------------------------------------------------------------------
// 1. 判断待ち
// ---------------------------------------------------------------------------

function renderWarnings(data) {
  const sources = data.sources;
  if (!sources || typeof sources !== 'object' || Array.isArray(sources)) return null;
  const errors = Object.entries(sources).filter(
    ([, value]) => typeof value === 'string' && /^error/i.test(value.trim()),
  );
  if (errors.length === 0) return null;

  const band = el('div', { class: 'warn-band', attrs: { role: 'alert' } });
  band.append(el('p', { text: '一部のデータ源でエラーが発生しています。数値が欠けている可能性があります。' }));
  const list = el('ul', { class: 'warn-list' });
  for (const [name, value] of errors) {
    list.append(el('li', { text: `${name}: ${value.replace(/^error:\s*/i, '')}` }));
  }
  band.append(list);
  return band;
}

function boardStorage() {
  return {
    get: safeStorageGet,
    set: safeStorageSet,
    remove: safeStorageRemove,
  };
}

function renderDecisions(data) {
  const section = panel('decisions', '判断ボード', '行をクリックすると詳細。右の列へドラッグするか、ボタンで回答できます');
  section.classList.add('panel--primary');
  const list = Array.isArray(data.decisions) ? data.decisions : [];
  if (list.length === 0) {
    section.append(emptyState('判断待ちはありません。'));
    return section;
  }
  const host = el('div', { class: 'board-host' });
  section.append(host);
  try {
    renderBoard(host, list, {
      now: Date.now(),
      storage: boardStorage(),
      fetchImpl: (...args) => fetch(...args),
      onChange: () => {},
    });
  } catch {
    clear(host);
    host.append(emptyState('判断ボードを表示できませんでした。GitHub の Issue から直接返信してください。'));
  }
  return section;
}

// ---------------------------------------------------------------------------
// 2. 事業
// ---------------------------------------------------------------------------

function kpiRows(app) {
  const kpis = app.kpis;
  if (!kpis || typeof kpis !== 'object' || Array.isArray(kpis)) {
    return [['KPI', formatKpi(null, 'KPI が未収集')]];
  }
  const reason = typeof kpis.missing_reason === 'string' ? kpis.missing_reason : '';
  const rows = [];
  for (const [key, value] of Object.entries(kpis)) {
    if (key === 'missing_reason') continue;
    rows.push([KPI_LABELS[key] ?? key, formatKpi(value, reason)]);
  }
  if (rows.length === 0) rows.push(['KPI', formatKpi(null, reason)]);
  return rows;
}

function renderAppCard(app) {
  const card = el('article', { class: 'app' });
  const head = el('div', { class: 'app-head' });
  head.append(el('h3', { class: 'app-name', text: app.name ?? '（名称未設定）' }));
  if (app.id) head.append(el('span', { class: 'app-id', text: app.id }));
  head.append(span('chip', phaseLabel(app.phase)));
  card.append(head);

  const release = app.release_target
    ? `${formatDaysUntil(app.release_target)}（${formatDateJa(app.release_target)}）`
    : '未取得：リリース目標日が未設定';
  card.append(
    metaList([
      ['フェーズ', phaseLabel(app.phase)],
      ['次のゲート', app.gate_next ? String(app.gate_next) : '未設定'],
      ['リリースまで', release],
    ]),
  );

  const kpis = el('dl', { class: 'kpi-list' });
  for (const [label, value] of kpiRows(app)) {
    kpis.append(el('dt', { class: 'kpi-key', text: label }));
    const classes = ['kpi-value'];
    if (value.startsWith('未取得')) classes.push('kpi-value--missing');
    else if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) classes.push('kpi-value--number');
    kpis.append(el('dd', { class: classes.join(' '), text: value }));
  }
  card.append(kpis);
  return card;
}

function renderApps(data) {
  const section = panel('apps', '事業', 'フェーズ・次のゲート・リリースまで・KPI');
  const list = Array.isArray(data.apps) ? data.apps : [];
  if (list.length === 0) {
    section.append(emptyState('アプリの登録がありません。'));
    return section;
  }
  for (const app of list) {
    if (app && typeof app === 'object') section.append(renderAppCard(app));
  }
  return section;
}

// ---------------------------------------------------------------------------
// 3. タスク
// ---------------------------------------------------------------------------

function renderTaskItem(task) {
  const item = el('li', { class: 'task' });
  const titleLine = el('div', { class: 'task-title-line' });
  const title = String(task.title ?? task.id ?? '（無題）');
  const href = safeHref(task.issue_url);
  if (href) {
    titleLine.append(externalAnchor(href, title, 'task-link'));
  } else {
    titleLine.append(el('span', { class: 'task-link task-link--plain', text: title }));
  }
  item.append(titleLine);

  const meta = el('div', { class: 'task-meta' });
  if (task.id) meta.append(span('task-id', String(task.id)));
  meta.append(span('role-chip', roleLabel(task.role)));
  item.append(meta);
  return item;
}

function renderTasks(data) {
  const section = panel('tasks', 'タスク', `状態別・各列 ${TASKS_PER_COLUMN} 件まで`);
  const tasks = data.tasks && typeof data.tasks === 'object' ? data.tasks : {};
  const board = el('div', { class: 'kanban' });
  for (const [key, label] of TASK_COLUMNS) {
    const items = Array.isArray(tasks[key]) ? tasks[key].filter((t) => t && typeof t === 'object') : [];
    const column = el('section', { class: 'kanban-col', attrs: { 'aria-label': label } });
    const head = el('div', { class: 'kanban-head' });
    head.append(el('h3', { class: 'kanban-title', text: label }));
    head.append(span('count', `${items.length}件`));
    column.append(head);

    if (items.length === 0) {
      column.append(emptyState('なし'));
    } else {
      const list = el('ul', { class: 'task-list' });
      for (const task of topN(items, TASKS_PER_COLUMN)) list.append(renderTaskItem(task));
      column.append(list);
      if (items.length > TASKS_PER_COLUMN) {
        column.append(el('p', { class: 'more', text: `ほか ${items.length - TASKS_PER_COLUMN} 件` }));
      }
    }
    board.append(column);
  }
  section.append(board);
  return section;
}

// ---------------------------------------------------------------------------
// 4. 費用
// ---------------------------------------------------------------------------

function renderFinance(data) {
  const section = panel('finance', '費用', '従量 API の本日分と今月合計');
  const finance = data.finance && typeof data.finance === 'object' ? data.finance : {};

  const moneyRow = el('div', { class: 'money-row' });
  moneyRow.append(span('money-value', formatUsd(finance.today_usd)));
  moneyRow.append(span('money-cap', `/ 上限 ${formatUsd(finance.cap_usd)}`));
  section.append(moneyRow);

  const ratio = percent(finance.today_usd, finance.cap_usd);
  const tone = ratio >= 100 ? 'bad' : ratio >= 80 ? 'warn' : 'ok';
  const hasMoney = [finance.today_usd, finance.cap_usd].every(
    (value) => value !== null && value !== undefined && Number.isFinite(Number(value)),
  );
  const progress = el('div', {
    class: 'progress',
    attrs: {
      role: 'progressbar',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': String(ratio),
      'aria-label': '本日の費用と上限',
    },
  });
  const fill = el('div', { class: `progress-fill progress-fill--${tone}` });
  fill.style.width = `${ratio}%`;
  progress.append(fill);
  section.append(progress);
  section.append(
    el('p', {
      class: 'progress-note',
      text: hasMoney ? `上限に対して ${ratio}% 使用` : '本日の金額または上限が未取得です',
    }),
  );

  const month = el('div', { class: 'finance-block' });
  const monthLine = el('p', { class: 'finance-line' });
  monthLine.append(el('span', { text: '今月の合計' }));
  monthLine.append(span('value', formatUsd(finance.month_usd)));
  month.append(monthLine);

  const routes = numericEntries(finance.by_route);
  if (routes.length === 0) {
    month.append(emptyState('経路別の内訳はありません。'));
  } else {
    month.append(el('h3', { class: 'section-heading', text: '経路別の内訳' }));
    const max = routes[0][1];
    const list = el('ul', { class: 'route-list' });
    for (const [route, value] of routes) {
      const row = el('li', { class: 'route-row' });
      row.append(el('span', { class: 'route-name', text: route }));
      const track = el('span', { class: 'mini-track' });
      const bar = el('span', { class: 'mini-bar' });
      bar.style.width = `${percent(value, max)}%`;
      track.append(bar);
      row.append(track);
      row.append(el('span', { class: 'route-usd', text: formatUsd(value) }));
      list.append(row);
    }
    month.append(list);
  }
  section.append(month);
  return section;
}

// ---------------------------------------------------------------------------
// 5. 接続
// ---------------------------------------------------------------------------

function renderConnections(data) {
  const section = panel('connections', '接続', '外部サービスとの接続状態');
  const list = Array.isArray(data.connections) ? data.connections : [];
  if (list.length === 0) {
    section.append(emptyState('接続の記録がありません。'));
    return section;
  }
  const ul = el('ul', { class: 'conn-list' });
  for (const conn of list) {
    if (!conn || typeof conn !== 'object') continue;
    const row = el('li', { class: 'conn-row' });
    row.append(el('span', { class: 'conn-name', text: conn.name ?? '（名前未設定）' }));
    if (conn.checked_at) {
      row.append(el('span', { class: 'conn-checked', text: `確認: ${formatElapsed(conn.checked_at)}` }));
    }
    row.append(badgeFor(conn.status));
    ul.append(row);
  }
  section.append(ul);
  return section;
}

// ---------------------------------------------------------------------------
// 6. 実行系の健康状態
// ---------------------------------------------------------------------------

function stat(label, value, note, level) {
  const box = el('div', { class: `stat stat--${level ?? 'unknown'}` });
  box.append(el('p', { class: 'stat-label', text: label }));
  box.append(el('p', { class: `stat-value stat-value--${level ?? 'unknown'}`, text: value }));
  if (note) box.append(el('p', { class: 'stat-note', text: note }));
  return box;
}

function renderOps(data) {
  const section = panel('ops', '実行系の健康状態', '心拍・ジョブ・冷却中の経路・停止状態');
  const ops = data.ops && typeof data.ops === 'object' ? data.ops : {};

  const heartbeat = heartbeatLevel(ops.heartbeat_at);
  const heartbeatValue =
    heartbeat === 'unknown' ? '不明' : formatElapsed(ops.heartbeat_at).replace('前', '');
  const heartbeatNote =
    heartbeat === 'unknown'
      ? '心拍の記録がありません'
      : `最終 ${formatDateTimeJa(ops.heartbeat_at)}（15分超で黄・60分超で赤）`;

  const grid = el('div', { class: 'ops-grid' });
  grid.append(stat('心拍からの経過', heartbeatValue, heartbeatNote, heartbeat));
  const daemonNote =
    ops.daemon === 'ok'
      ? 'launchd で常駐しています'
      : ops.daemon === 'stale'
        ? '心拍が途絶えています'
        : '状態を取得できませんでした';
  grid.append(stat('デーモン', statusLabel(ops.daemon), daemonNote, statusTone(ops.daemon)));
  grid.append(
    stat(
      '本日の期限切れ',
      ops.expired_leases_today === null || ops.expired_leases_today === undefined
        ? '未取得'
        : `${ops.expired_leases_today}件`,
      '担当の期限切れで ready に戻した件数',
      ops.expired_leases_today === 0 ? 'ok' : ops.expired_leases_today ? 'yellow' : 'unknown',
    ),
  );
  grid.append(
    stat(
      '停止状態',
      ops.paused === true ? '一時停止中' : ops.paused === false ? '稼働中' : '不明',
      ops.paused === true ? '心拍・巡回・ダッシュボードは継続します' : '停止指示はありません',
      ops.paused === true ? 'red' : ops.paused === false ? 'ok' : 'unknown',
    ),
  );
  section.append(grid);

  const jobs = Array.isArray(ops.jobs) ? ops.jobs.filter((j) => j && typeof j === 'object') : [];
  if (jobs.length > 0) {
    section.append(el('h3', { class: 'section-heading', text: 'ジョブの最終実行' }));
    const ul = el('ul', { class: 'jobs-list' });
    for (const job of jobs) {
      const row = el('li', { class: 'job-row' });
      row.append(el('span', { class: 'job-name', text: job.name ?? '（名前未設定）' }));
      row.append(
        el('span', {
          class: 'job-run',
          text: job.last_run ? `最終 ${formatElapsed(job.last_run)}` : '実行記録なし',
        }),
      );
      row.append(badgeFor(job.status));
      ul.append(row);
    }
    section.append(ul);
  }

  if (Array.isArray(ops.cooling_routes) && ops.cooling_routes.length > 0) {
    section.append(el('h3', { class: 'section-heading', text: '冷却中の経路' }));
    const list = el('ul', { class: 'chip-list' });
    for (const route of ops.cooling_routes) {
      const chip = el('li', { class: 'route-chip' });
      if (typeof route === 'string') {
        chip.append(el('span', { class: 'route-name', text: route }));
      } else if (route && typeof route === 'object') {
        chip.append(el('span', { class: 'route-name', text: route.route ?? route.name ?? '（経路不明）' }));
        if (route.until) chip.append(span('route-usd', `再開 ${formatDateTimeJa(route.until)}`));
        if (route.reason) chip.append(el('span', { text: String(route.reason) }));
      }
      list.append(chip);
    }
    section.append(list);
  }
  return section;
}

// ---------------------------------------------------------------------------
// 7. 日報・学び
// ---------------------------------------------------------------------------

function markdownInline(host, nodes) {
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'text':
        host.append(document.createTextNode(node.text));
        break;
      case 'strong': {
        const strong = el('strong');
        markdownInline(strong, node.children);
        host.append(strong);
        break;
      }
      case 'em': {
        const em = el('em');
        markdownInline(em, node.children);
        host.append(em);
        break;
      }
      case 'code':
        host.append(el('code', { text: node.text }));
        break;
      case 'link': {
        const href = safeHref(node.href);
        if (href) {
          const anchor = externalAnchor(href, '', undefined);
          markdownInline(anchor, node.children);
          host.append(anchor);
        } else {
          markdownInline(host, node.children);
        }
        break;
      }
      default:
        if (typeof node.text === 'string') host.append(document.createTextNode(node.text));
    }
  }
}

function markdownBlockNode(block) {
  switch (block.type) {
    case 'heading': {
      const tag = block.level <= 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5';
      const heading = el(tag);
      markdownInline(heading, block.children);
      return heading;
    }
    case 'paragraph': {
      const paragraph = el('p');
      markdownInline(paragraph, block.children);
      return paragraph;
    }
    case 'list': {
      const list = el(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) {
        const li = el('li');
        markdownInline(li, item.children);
        list.append(li);
      }
      return list;
    }
    case 'quote': {
      const quote = el('blockquote');
      markdownInline(quote, block.children);
      return quote;
    }
    case 'code': {
      const pre = el('pre');
      const code = el('code', { text: block.text });
      if (block.lang) code.setAttribute('data-lang', block.lang);
      pre.append(code);
      return pre;
    }
    case 'hr':
      return el('hr');
    default:
      return el('span');
  }
}

function markdown(source, className = 'md') {
  const host = el('div', { class: className });
  if (typeof source !== 'string' || source.trim() === '') {
    host.append(emptyState('本文なし'));
    return host;
  }
  for (const block of parseMarkdown(source)) host.append(markdownBlockNode(block));
  return host;
}

function timelineRows(items) {
  const groups = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const dept = typeof item.dept === 'string' && item.dept !== '' ? item.dept : 'unknown';
    if (!groups.has(dept)) groups.set(dept, []);
    groups.get(dept).push(item);
  }
  const order = [...groups.keys()].sort((a, b) => deptRank(a) - deptRank(b));
  return order.map((dept) => [dept, groups.get(dept)]);
}

function tickLine(leftPct) {
  const line = el('span', { class: 'tick-line', attrs: { 'aria-hidden': 'true' } });
  line.style.left = `${leftPct}%`;
  return line;
}

function renderTimeline(items) {
  const wrap = el('div', { class: 'timeline' });
  wrap.append(el('h3', { class: 'section-heading', text: '稼働タイムライン' }));
  wrap.append(
    el('p', {
      class: 'timeline-note',
      text: 'Google カレンダーと同じ内容です。バーをホバーするかタップすると詳細が出ます（狭い画面では横にスクロールできます）。',
    }),
  );

  if (items.length === 0) {
    wrap.append(emptyState('稼働の記録はありません。'));
    return wrap;
  }

  const scroller = el('div', { class: 'timeline-scroll' });
  const table = el('div', { class: 'timeline-table', attrs: { role: 'group', 'aria-label': '部署別 稼働タイムライン' } });

  const axis = el('div', { class: 'timeline-row timeline-axis' });
  axis.append(el('span', { class: 'timeline-label', text: '時刻' }));
  const axisTrack = el('div', { class: 'timeline-track' });
  for (const hour of CLOCK_HOURS) {
    const tickClass =
      hour === 0 ? 'tick-label tick-label--start' : hour === 24 ? 'tick-label tick-label--end' : 'tick-label';
    const tick = el('span', { class: tickClass, text: `${hour}時` });
    tick.style.left = `${(hour / 24) * 100}%`;
    axisTrack.append(tick);
  }
  axis.append(axisTrack);
  table.append(axis);

  const bars = [];
  for (const [dept, deptItems] of timelineRows(items)) {
    const row = el('div', { class: 'timeline-row' });
    row.append(el('span', { class: 'timeline-label', text: deptLabel(dept) }));
    const track = el('div', { class: 'timeline-track' });
    for (const hour of GRID_HOURS) track.append(tickLine((hour / 24) * 100));

    for (const item of deptItems) {
      const spanInfo = ganttSpan(item.start, item.end);
      if (!spanInfo) continue;
      const tone = statusTone(item.status);
      const bar = el('button', {
        class: `gantt-bar gantt-bar--${tone}`,
        attrs: {
          type: 'button',
          'aria-pressed': 'false',
          'aria-label': `${deptLabel(item.dept)} ${item.title ?? '作業'} ${formatTimeJa(item.start)}〜${formatTimeJa(item.end)} ${statusLabel(item.status)}`,
          title: `${item.title ?? '作業'}（${formatTimeJa(item.start)}〜${formatTimeJa(item.end)}）`,
        },
      });
      bar.style.left = `${spanInfo.leftPct}%`;
      bar.style.width = `${spanInfo.widthPct}%`;
      bar.addEventListener('click', () => selectTimelineItem(item, bar));
      bar.addEventListener('mouseenter', () => selectTimelineItem(item, bar));
      bar.addEventListener('focus', () => selectTimelineItem(item, bar));
      bars.push(bar);
      track.append(bar);
    }
    row.append(track);
    table.append(row);
  }

  scroller.append(table);
  wrap.append(scroller);

  const detail = el('div', { class: 'timeline-detail', attrs: { 'aria-live': 'polite' } });
  detail.append(el('p', { class: 'timeline-detail-empty', text: 'バーを選ぶと詳細が出ます。' }));
  wrap.append(detail);

  function selectTimelineItem(item, bar) {
    for (const other of bars) other.setAttribute('aria-pressed', 'false');
    bar.setAttribute('aria-pressed', 'true');
    clear(detail);
    detail.append(el('p', { class: 'detail-title', text: item.title ?? '（作業名なし）' }));
    const metaText = [
      `${deptLabel(item.dept)}${item.role ? `／${roleLabel(item.role)}` : ''}`,
      `${formatTimeJa(item.start)}〜${formatTimeJa(item.end)}`,
      `結果: ${statusLabel(item.status)}`,
    ].join(' ・ ');
    detail.append(el('p', { class: 'detail-meta', text: metaText }));
  }

  return wrap;
}

function appendDeptReports(host, depts, heading) {
  const entries = depts && typeof depts === 'object' && !Array.isArray(depts) ? Object.entries(depts) : [];
  if (entries.length === 0) return;
  entries.sort((a, b) => deptRank(a[0]) - deptRank(b[0]));
  host.append(el('h3', { class: 'section-heading', text: heading }));
  const list = el('div', { class: 'dept-list' });
  for (const [dept, body] of entries) {
    const details = el('details', { class: 'dept-card' });
    details.append(el('summary', { text: deptLabel(dept) }));
    const bodyHost = el('div', { class: 'dept-body' });
    bodyHost.append(markdown(typeof body === 'string' ? body : '', 'md'));
    details.append(bodyHost);
    list.append(details);
  }
  host.append(list);
}

/** 役職別の学び（24 役職）。部署順 → 部長・実行・レビューの順に並べる。 */
function appendRoleLearnings(host, roles) {
  const entries = roles && typeof roles === 'object' && !Array.isArray(roles) ? Object.entries(roles) : [];
  if (entries.length === 0) return;
  const levelRank = { lead: 0, exec: 1, review: 2 };
  const parse = (id) => {
    const idx = id.lastIndexOf('-');
    return [id.slice(0, idx), id.slice(idx + 1)];
  };
  entries.sort((a, b) => {
    const [da, la] = parse(a[0]);
    const [db, lb] = parse(b[0]);
    return deptRank(da) - deptRank(db) || (levelRank[la] ?? 9) - (levelRank[lb] ?? 9);
  });
  host.append(el('h3', { class: 'section-heading', text: '役職別の学び（蓄積）' }));
  const list = el('div', { class: 'dept-list' });
  for (const [role, body] of entries) {
    const details = el('details', { class: 'dept-card' });
    details.append(el('summary', { text: roleLabel(role) }));
    const bodyHost = el('div', { class: 'dept-body' });
    bodyHost.append(markdown(typeof body === 'string' ? body : '', 'md'));
    details.append(bodyHost);
    list.append(details);
  }
  host.append(list);
}

/** 過去の日報・学び（テキストのみ）。新しい日から並べる。 */
function appendReportHistory(host, history) {
  const days = Array.isArray(history) ? history.filter((d) => d && typeof d === 'object') : [];
  if (days.length === 0) return;
  host.append(el('h3', { class: 'section-heading', text: '過去の日報・学び' }));
  const list = el('div', { class: 'history-list' });
  for (const day of days) {
    const details = el('details', { class: 'dept-card history-card' });
    details.append(el('summary', { text: formatDateJa(day.date) }));
    const body = el('div', { class: 'dept-body' });
    body.append(el('h4', { class: 'section-heading', text: '全社日報' }));
    body.append(markdown(day.company_md));
    body.append(el('h4', { class: 'section-heading', text: '学び' }));
    body.append(markdown(day.learnings_md));
    appendDeptReports(body, day.depts, '部署別の日報');
    details.append(body);
    list.append(details);
  }
  host.append(list);
}

function renderReports(data) {
  const section = panel('reports', '日報・学び', '全社日報・学び・部署別の日報・稼働タイムライン');
  const reports = data.reports && typeof data.reports === 'object' ? data.reports : {};

  section.append(
    el('p', {
      class: 'report-date',
      text: reports.date ? `日報: ${formatDateJa(reports.date)}` : '日報: 日付不明',
    }),
  );

  const figures = el('div', { class: 'figures' });
  const companyFigure = el('div', { class: 'figure-slot' });
  companyFigure.append(el('h3', { class: 'section-heading', text: '全社日報（グラレコ）' }));
  appendImage(companyFigure, reports.company_png, '全社日報のグラレコ');
  figures.append(companyFigure);

  const learningsFigure = el('div', { class: 'figure-slot' });
  learningsFigure.append(el('h3', { class: 'section-heading', text: '学び（グラレコ）' }));
  appendImage(learningsFigure, reports.learnings_png, '学びのグラレコ');
  figures.append(learningsFigure);
  section.append(figures);

  section.append(el('h3', { class: 'section-heading', text: '全社日報 本文' }));
  section.append(markdown(reports.company_md));

  section.append(el('h3', { class: 'section-heading', text: '学び 本文' }));
  section.append(markdown(reports.learnings_md));

  appendDeptReports(section, reports.depts, '部署別の日報');
  appendRoleLearnings(section, reports.role_learnings);
  appendReportHistory(section, reports.history);

  if (typeof reports.missing_reason === 'string' && reports.missing_reason) {
    section.append(el('p', { class: 'img-missing', text: reports.missing_reason }));
  }

  const timeline = Array.isArray(data.timeline) ? data.timeline : [];
  section.append(renderTimeline(timeline));
  return section;
}

// ---------------------------------------------------------------------------
// 全体の描画
// ---------------------------------------------------------------------------

function renderDashboard(data) {
  const dash = $('#dashboard');
  if (!dash) return;
  clear(dash);

  const warning = renderWarnings(data);
  if (warning) dash.append(warning);
  dash.append(renderKpiTiles(data, Date.now()));
  dash.append(renderDecisions(data));
  dash.append(renderPhaseSection(data, Date.now()));
  dash.append(renderAgentsSection(data, Date.now()));
  dash.append(renderModelsSection(data, Date.now()));
  dash.append(renderFinanceSection(data, Date.now()));
  dash.append(renderApps(data));
  dash.append(renderTasks(data));
  dash.append(renderConnections(data));
  dash.append(renderOps(data));
  dash.append(renderReports(data));
}

// ---------------------------------------------------------------------------
// 解錠・ロック・読み込み
// ---------------------------------------------------------------------------

function setLockMessage(message) {
  const host = $('#lock-message');
  if (host) host.textContent = message;
}

function setBootError(message) {
  const host = $('#boot-error');
  if (!host) return;
  host.textContent = message;
  host.hidden = message === '';
}

function setBusy(busy) {
  const button = $('#unlock-button');
  const input = $('#passphrase');
  if (button) {
    button.disabled = busy;
    button.textContent = busy ? '解錠中…' : '解錠する';
  }
  if (input) input.disabled = busy;
}

function safeStorageGet(key) {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key, value) {
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeStorageRemove(key) {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* 保存できない環境では何もしない */
  }
}

function showLock(message) {
  const lockScreen = $('#lock-screen');
  const dashboard = $('#dashboard');
  const lockButton = $('#lock-button');
  if (lockScreen) lockScreen.hidden = false;
  if (dashboard) {
    dashboard.hidden = true;
    clear(dashboard);
  }
  if (lockButton) lockButton.hidden = true;
  const meta = $('#header-meta');
  if (meta) clear(meta);
  setLockMessage(message ?? '');
}

function showDashboard(data) {
  state.data = data;
  const lockScreen = $('#lock-screen');
  const dashboard = $('#dashboard');
  const lockButton = $('#lock-button');
  if (lockScreen) lockScreen.hidden = true;
  if (dashboard) dashboard.hidden = false;
  if (lockButton) lockButton.hidden = state.demo;
  setLockMessage('');
  setBootError('');
  renderDashboard(data);
  renderHeader(data);
  startClock();
  enhanceMotion(dashboard);
}

function lock() {
  stopClock();
  disableMotion();
  safeStorageRemove(PASS_STORAGE_KEY);
  safeStorageRemove(TOKEN_KEY);
  state.data = null;
  const dashboard = $('#dashboard');
  if (dashboard) {
    clear(dashboard);
    dashboard.hidden = true;
  }
  if (state.demo) {
    location.assign(location.pathname);
    return;
  }
  showLock('');
  const input = $('#passphrase');
  if (input) {
    input.value = '';
    input.focus();
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`${url} を取得できませんでした（HTTP ${response.status}）`);
  }
  return response.json();
}

async function unlockWith(passphrase) {
  const envelope = await fetchJson('data.enc.json');
  return decryptEnvelope(envelope, passphrase);
}

function describeError(error) {
  if (error instanceof DecryptionError) {
    if (error.code === 'bad-passphrase') return 'パスフレーズが違います';
    return `暗号データを読めませんでした: ${error.message}`;
  }
  if (error && typeof error.message === 'string' && error.message !== '') {
    return `読み込みに失敗しました: ${error.message}`;
  }
  return '読み込みに失敗しました';
}

async function handleUnlock(event) {
  event.preventDefault();
  const input = $('#passphrase');
  const passphrase = input ? input.value : '';
  if (typeof passphrase !== 'string' || passphrase === '') {
    setLockMessage('パスフレーズを入力してください。');
    return;
  }
  setBusy(true);
  setLockMessage('');
  try {
    const data = await unlockWith(passphrase);
    const saved = safeStorageSet(PASS_STORAGE_KEY, passphrase);
    showDashboard(data);
    if (!saved) {
      setBootError('このブラウザではパスフレーズを保持できません。再読み込みの際は再入力してください。');
    }
    if (input) input.value = '';
  } catch (error) {
    safeStorageRemove(PASS_STORAGE_KEY);
    setLockMessage(describeError(error));
  } finally {
    setBusy(false);
  }
}

async function boot() {
  const params = new URLSearchParams(location.search);
  state.demo = params.get('demo') === '1';

  initTheme($('#theme-button'));
  const lockForm = $('#lock-form');
  if (lockForm) lockForm.addEventListener('submit', handleUnlock);
  const lockButton = $('#lock-button');
  if (lockButton) lockButton.addEventListener('click', lock);

  if (state.demo) {
    try {
      const data = await fetchJson('sample-data.json');
      showDashboard(data);
    } catch (error) {
      setBootError(describeError(error));
      showLock('');
    }
    return;
  }

  const saved = safeStorageGet(PASS_STORAGE_KEY);
  if (!saved) {
    showLock('');
    return;
  }
  setBusy(true);
  try {
    const data = await unlockWith(saved);
    showDashboard(data);
  } catch (error) {
    safeStorageRemove(PASS_STORAGE_KEY);
    showLock(describeError(error));
  } finally {
    setBusy(false);
  }
}

boot();
