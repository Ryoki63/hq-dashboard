// dashboard/views.js — ダッシュボード v2 の各セクション画面
//
// 5 つの関数はどれも `<section class="panel view-…" id="…">` を返す。
// DOM は createElement / textContent だけで組み立てる（innerHTML・インライン style 禁止）。
// 古い data（キー欠落・null・空配列・文字列要素）でも例外を投げず、空状態を出す。
// 0 と null は区別する: 0 は「0」、null/未定義は「未取得」。

import {
  donut,
  gauge,
  hbar,
  heatstrip,
  legend,
  lineChart,
  paletteColor,
  stepper,
} from './charts.js';
import {
  deptLabel,
  formatDateJa,
  formatDateTimeJa,
  formatDaysUntil,
  formatElapsed,
  formatRemaining,
  formatTimeJa,
  formatUsd,
  numericEntries,
  parseTime,
  phaseLabel,
  roleLabel,
} from './lib.js';

export const MISSING_TEXT = 'このデータにはまだ含まれていません(次回の更新で表示されます)';

const HOUR_MS = 3600 * 1000;
const JST_OFFSET_MS = 9 * HOUR_MS;

// ---------------------------------------------------------------------------
// 小さな道具

function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function add(parent, ...kids) {
  for (const kid of kids) {
    if (kid !== null && kid !== undefined) parent.append(kid);
  }
  return parent;
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 有限な数だけ通す。それ以外は null（0 は 0 のまま）。 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

function objs(list) {
  return Array.isArray(list) ? list.filter(isObj) : [];
}

function nowMsOf(now) {
  const d = parseTime(now);
  return d ? d.getTime() : Date.now();
}

/** チャート関数は null を返すのが正常。例外も空状態に倒す。 */
function tryChart(fn) {
  try {
    return fn() ?? null;
  } catch {
    return null;
  }
}

function fmtCount(n) {
  return `${n}回`;
}

function fmtMinutes(n) {
  if (n === null) return '未取得';
  if (n >= 60) {
    const hours = Math.floor(n / 60);
    const minutes = Math.round(n - hours * 60);
    return minutes === 0 ? `${hours}時間` : `${hours}時間${minutes}分`;
  }
  const rounded = Math.round(n * 10) / 10;
  return `${rounded}分`;
}

function fmtHoursShort(n) {
  if (n === null) return '未取得';
  return n >= 60 ? `${Math.round((n / 60) * 10) / 10}h` : `${Math.round(n)}分`;
}

function fmtPct(part, total) {
  if (part === null || total === null || total <= 0) return null;
  return `${Math.round((part / total) * 100)}%`;
}

function makeSection(id, cls, title, note) {
  const section = h('section', `panel view-section ${cls}`);
  section.setAttribute('id', id);
  const head = h('div', 'view-head');
  add(head, h('h2', 'view-title', title));
  if (note) add(head, h('p', 'view-note', note));
  add(section, head);
  return section;
}

function emptyState(message) {
  return h('p', 'view-empty', message ?? MISSING_TEXT);
}

function subHeading(text, note) {
  const wrap = h('div', 'view-subhead');
  add(wrap, h('h3', 'view-subtitle', text));
  if (note) add(wrap, h('p', 'view-subnote', note));
  return wrap;
}

function missingLine(label, reason) {
  const r = str(reason);
  return `${label}: 未取得${r ? `（${r}）` : ''}`;
}

/** ドーナツ + 凡例。描けないときは空状態。 */
function donutBlock(items, opts) {
  const total = items.reduce((sum, item) => sum + (num(item.value) ?? 0), 0);
  const wrap = h('div', 'view-donut');
  const svg =
    total > 0
      ? tryChart(() =>
          donut(items, {
            size: 168,
            thickness: 28,
            centerValue: opts.centerValue,
            centerLabel: opts.centerLabel,
            ariaLabel: opts.ariaLabel,
          }),
        )
      : null;
  if (!svg) {
    add(wrap, emptyState(opts.emptyText ?? '集計できる値がまだありません'));
    return wrap;
  }
  const chart = h('div', 'view-chart view-chart--donut');
  add(chart, svg);
  add(wrap, chart);
  const legendEl = tryChart(() => legend(items, { total, showPercent: opts.showPercent !== false }));
  if (legendEl) add(wrap, legendEl);
  return wrap;
}

// ---------------------------------------------------------------------------
// フェーズの共通解釈（KPI とフェーズ画面で使う）

function normalizePhases(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (typeof p === 'string' && p.trim() !== '') out.push({ id: p.trim(), label: phaseLabel(p.trim()) });
    else if (isObj(p) && str(p.id)) out.push({ id: p.id.trim(), label: str(p.label) ?? phaseLabel(p.id.trim()) });
  }
  return out;
}

/** { name, currentLabel, hasOverview } */
function currentPhaseInfo(data) {
  const overview = isObj(data?.overview) ? data.overview : null;
  const apps = objs(data?.apps);
  const app = apps[0] ?? null;
  if (overview) {
    const phases = normalizePhases(overview.phases);
    const found = phases.find((p) => p.id === overview.current);
    if (found) return { label: found.label, fromOverview: true };
    if (str(overview.current)) return { label: phaseLabel(overview.current), fromOverview: true };
    if (overview.current === null && app && str(app.phase)) {
      return { label: phaseLabel(app.phase), fromOverview: false };
    }
    return { label: null, fromOverview: true };
  }
  if (app && str(app.phase)) return { label: phaseLabel(app.phase), fromOverview: false };
  return { label: null, fromOverview: false };
}

// ---------------------------------------------------------------------------
// KPI タイル

function tile(label, value, sub, tone, valueSmall) {
  const node = h('div', `view-tile${tone ? ` view-tile--${tone}` : ''}`);
  add(node, h('p', 'view-tile-label', label));
  add(node, h('p', `view-tile-value${valueSmall ? ' view-tile-value--text' : ''}`, value));
  if (sub) add(node, h('p', 'view-tile-sub', sub));
  return node;
}

export function renderKpiTiles(data, now) {
  const section = makeSection('kpis', 'view-kpis', 'ひと目で見る状況', '最新の取得結果');
  const d = isObj(data) ? data : {};
  const grid = h('div', 'view-tiles');

  // 今日の支出 / 上限
  {
    const f = isObj(d.finance) ? d.finance : null;
    const today = num(f?.today_usd);
    const cap = num(f?.cap_usd);
    if (today === null) {
      add(grid, tile('今日の支出', '未取得', str(f?.missing_reason) ?? '費用データがありません', 'muted', false));
    } else {
      const ratio = cap !== null && cap > 0 ? today / cap : null;
      const pct = ratio === null ? null : Math.round(ratio * 100);
      const warn = ratio !== null && ratio > 0.8;
      const sub =
        cap === null
          ? '上限 未取得'
          : `上限 ${formatUsd(cap)} の ${pct}%${warn ? '（80%超: 注意）' : ''}`;
      add(grid, tile('今日の支出', formatUsd(today), sub, warn ? 'warn' : 'accent', false));
    }
  }

  // 累計の赤字
  {
    const f = isObj(d.finance) ? d.finance : null;
    const deficit = num(f?.deficit_usd);
    if (deficit === null) {
      add(grid, tile('累計の赤字', '未取得', str(f?.deficit_basis) ?? '集計前です', 'muted', false));
    } else {
      const revenueMissing = f.revenue_usd === null || f.revenue_usd === undefined;
      const sub = revenueMissing ? '売上 未接続（支出の全額を赤字として表示）' : `売上 ${formatUsd(num(f.revenue_usd))}`;
      add(grid, tile('累計の赤字', formatUsd(deficit), sub, deficit > 0 ? 'warn' : 'ok', false));
    }
  }

  // 判断待ち
  {
    if (!Array.isArray(d.decisions)) {
      add(grid, tile('判断待ち', '未取得', '判断データがありません', 'muted', false));
    } else {
      const pending = objs(d.decisions).filter((x) => x.status === undefined || x.status === null || x.status === 'pending');
      let sub = '判断待ちはありません';
      if (pending.length > 0) {
        const times = pending.map((x) => parseTime(x.deadline)).filter(Boolean).map((t) => t.getTime());
        sub = times.length > 0 ? `最短の期限: ${formatRemaining(new Date(Math.min(...times)), now)}` : '期限の記載なし';
      }
      add(grid, tile('判断待ち', `${pending.length}件`, sub, pending.length > 0 ? 'accent' : 'ok', false));
    }
  }

  // 稼動中のエージェント
  {
    const a = isObj(d.agents) ? d.agents : null;
    const running = num(a?.running_now);
    if (running === null) {
      add(grid, tile('稼動中のエージェント', '未取得', 'エージェントの稼動データがありません', 'muted', false));
    } else {
      const total = num(a.total_runs);
      const sub = total === null ? '直近の実行回数 未取得' : `直近${num(a.window_hours) ?? 24}時間で ${total} 回実行`;
      add(grid, tile('稼動中のエージェント', `${running}`, sub, running > 0 ? 'ok' : 'accent', false));
    }
  }

  // 現在フェーズ
  {
    const info = currentPhaseInfo(d);
    const overview = isObj(d.overview) ? d.overview : null;
    const app = objs(d.apps)[0] ?? null;
    const appName = str(overview?.app_name) ?? str(app?.name);
    if (info.label === null) {
      add(grid, tile('現在のフェーズ', '未取得', 'フェーズの情報がありません', 'muted', false));
    } else {
      add(grid, tile('現在のフェーズ', info.label, appName ? `${appName} の進行段階` : null, 'accent', true));
    }
  }

  add(section, grid);
  return section;
}

// ---------------------------------------------------------------------------
// フェーズ

function kvRow(list, key, value, extra) {
  const row = h('div', 'view-kv-row');
  add(row, h('dt', 'view-kv-key', key));
  const dd = h('dd', 'view-kv-val', value);
  if (extra) add(dd, h('span', 'view-kv-extra', extra));
  add(row, dd);
  add(list, row);
}

export function renderPhaseSection(data, now) {
  const section = makeSection('phase', 'view-phase', '全体フェーズ', '事業がどの段階にいるか');
  const d = isObj(data) ? data : {};
  const overview = isObj(d.overview) ? d.overview : null;
  const app = objs(d.apps)[0] ?? null;

  if (!overview && !app) {
    add(section, emptyState());
    return section;
  }

  if (overview) {
    const phases = normalizePhases(overview.phases);
    const idx = phases.findIndex((p) => p.id === overview.current);
    if (phases.length > 0) {
      const wrap = h('div', 'view-stepper');
      const stepperEl = tryChart(() => stepper(phases, idx, { ariaLabel: '全体フェーズの進行' }));
      if (stepperEl) add(wrap, stepperEl);
      add(section, wrap);
    } else {
      add(section, emptyState('フェーズ一覧が取得できていません'));
    }
    if (idx < 0 && str(overview.current) === null) {
      add(section, h('p', 'view-notice', '現在のフェーズは判定できませんでした（未取得）'));
    }
  } else {
    // 古い data: apps[0] の phase だけで縮退
    const wrap = h('div', 'view-fallback');
    add(wrap, h('p', 'view-fallback-label', '現在のフェーズ'));
    add(wrap, h('p', 'view-fallback-value', phaseLabel(app.phase)));
    add(wrap, h('p', 'view-note', '全体フェーズの一覧は次回の更新で表示されます'));
    add(section, wrap);
  }

  const src = overview ?? {};
  const appName = str(src.app_name) ?? str(app?.name);
  const gateNext = str(src.gate_next) ?? str(app?.gate_next);
  const release = str(src.release_target) ?? str(app?.release_target);
  const accountable = str(src.accountable);
  const exitGate = str(src.exit_gate);

  const list = h('dl', 'view-kv');
  kvRow(list, 'アプリ', appName ?? '未取得');
  if (overview && str(overview.app_phase_raw)) {
    kvRow(list, 'アプリのフェーズ', phaseLabel(overview.app_phase_raw));
  }
  kvRow(list, '次のゲート', gateNext ?? '未取得');
  if (release) {
    kvRow(list, 'リリース目標日', formatDateJa(release), formatDaysUntil(release, now));
  } else {
    kvRow(list, 'リリース目標日', '未設定');
  }
  kvRow(list, '責任者', accountable ? roleLabel(accountable) : '未取得', accountable && accountable !== roleLabel(accountable) ? accountable : null);
  add(section, list);

  if (exitGate) {
    const box = h('div', 'view-gate');
    add(box, h('h3', 'view-subtitle', '次のゲートを通る条件（原文）'));
    add(box, h('p', 'view-gate-text', exitGate));
    add(section, box);
  }
  return section;
}

// ---------------------------------------------------------------------------
// 部署別稼動

const DEPT_ORDER = ['pmo', 'product', 'ux', 'eng', 'qa', 'mkt', 'ops', 'fin'];

function deptOfRole(role) {
  if (typeof role !== 'string') return null;
  const i = role.lastIndexOf('-');
  return i > 0 ? role.slice(0, i) : role;
}

function deptIndex(dept) {
  const i = DEPT_ORDER.indexOf(dept);
  return i >= 0 ? i : DEPT_ORDER.length - 1;
}

function hourLabels(nowMs) {
  const currentHour = new Date(nowMs + JST_OFFSET_MS).getUTCHours();
  const labels = [];
  for (let i = 0; i < 24; i += 1) {
    labels.push(`${(currentHour - 23 + i + 48) % 24}時`);
  }
  return labels;
}

function normalizeHourly(v) {
  if (!Array.isArray(v) || v.length !== 24) return null;
  return v.map((x) => num(x) ?? 0);
}

function deptCard(dept, index0, maxBusy, labels, now) {
  const index = DEPT_ORDER.includes(dept.dept) ? deptIndex(dept.dept) : index0;
  const runs = num(dept.runs);
  const busy = num(dept.busy_minutes);
  const idle = runs === 0;
  const card = h('article', `view-card view-dept${idle ? ' view-dept--idle' : ''}`);
  const name = str(dept.dept);

  const head = h('div', 'view-card-head');
  const title = h('h3', 'view-card-title');
  add(title, h('span', `view-dot view-bg${(index % 8) + 1}`));
  add(title, h('span', 'view-card-name', name ? deptLabel(name) : '不明'));
  add(head, title);
  const running = num(dept.running);
  if (running !== null && running > 0) add(head, h('span', 'view-badge view-badge--ok', `実行中 ${running}`));
  add(card, head);

  const util = num(dept.utilization);
  const target = num(dept.utilization_target) ?? 0.86;
  if (util !== null) {
    const pct = Math.round(util * 100);
    add(card, h('p', util >= target ? 'view-ok' : 'view-fail', `稼働率 ${pct}%（目標 ${Math.round(target * 100)}%）`));
  }

  const count = h('p', 'view-dept-runs');
  add(count, h('span', 'view-dept-runs-num', runs === null ? '未取得' : `${runs}`));
  if (runs !== null) add(count, h('span', 'view-dept-runs-unit', '回実行'));
  add(card, count);

  if (idle) {
    add(card, h('p', 'view-dept-idle', 'この24時間は稼動なし'));
  } else {
    const ok = num(dept.ok);
    const fail = num(dept.fail);
    const result = h('p', 'view-dept-result');
    add(result, h('span', 'view-ok', ok === null ? '成功 未取得' : `成功 ${ok}`));
    add(result, h('span', fail !== null && fail > 0 ? 'view-fail' : 'view-ok', fail === null ? '失敗 未取得' : `失敗 ${fail}`));
    add(card, result);
  }

  // 稼動分の横棒
  const barWrap = h('div', 'view-chart view-chart--bar');
  const bar =
    busy === null
      ? null
      : tryChart(() =>
          hbar(
            [{ label: '稼動', value: busy, valueText: fmtMinutes(busy), color: paletteColor(index) }],
            { max: maxBusy > 0 ? maxBusy : 1, ariaLabel: `${name ? deptLabel(name) : '部署'}の稼動時間` },
          ),
        );
  add(barWrap, bar ?? h('p', 'view-empty view-empty--inline', missingLine('稼動時間', null)));
  add(card, barWrap);

  // 24 時間のヒートストリップ
  const hourly = normalizeHourly(dept.hourly);
  const heat = hourly
    ? tryChart(() => heatstrip(hourly, { labels, ariaLabel: `${name ? deptLabel(name) : '部署'}の24時間の稼動` }))
    : null;
  const heatWrap = h('div', 'view-heat');
  if (heat) {
    const chartBox = h('div', 'view-chart view-chart--heat');
    add(chartBox, heat);
    add(heatWrap, chartBox);
    const axis = h('p', 'view-heat-axis');
    add(axis, h('span', '', '24時間前'), h('span', '', 'いま'));
    add(heatWrap, axis);
  } else {
    add(heatWrap, h('p', 'view-empty view-empty--inline', '時間帯別の稼動: 未取得'));
  }
  add(card, heatWrap);

  const foot = h('p', 'view-dept-foot');
  if (dept.last_run_at === null || dept.last_run_at === undefined) {
    foot.textContent = idle ? '最終実行: なし' : '最終実行: 未取得';
  } else {
    foot.textContent = `最終実行: ${formatElapsed(dept.last_run_at, now)}`;
  }
  const cost = num(dept.cost_usd);
  if (cost !== null && cost > 0) foot.textContent += `・費用 ${formatUsd(cost)}`;
  add(card, foot);
  return card;
}

export function renderAgentsSection(data, now) {
  const d = isObj(data) ? data : {};
  const a = isObj(d.agents) ? d.agents : null;
  const win = num(a?.window_hours) ?? 24;
  const section = makeSection('agents', 'view-agents', '部署別の稼動', `直近${win}時間の実行記録`);
  if (!a) {
    add(section, emptyState());
    return section;
  }

  const depts = objs(a.depts);
  if (depts.length === 0) {
    add(section, emptyState('部署別の稼動データがまだありません'));
  } else {
    const maxBusy = Math.max(0, ...depts.map((x) => num(x.busy_minutes) ?? 0));
    const labels = hourLabels(nowMsOf(now));
    const grid = h('div', 'view-cards');
    depts.forEach((dept, i) => add(grid, deptCard(dept, i, maxBusy, labels, now)));
    add(section, grid);

    // 稼動分シェアのドーナツ
    const block = h('div', 'view-block');
    add(block, subHeading('稼動分のシェア（部署別）', '稼動した時間の割合'));
    const items = depts
      .map((dept, i) => ({
        label: str(dept.dept) ? deptLabel(dept.dept) : '不明',
        value: num(dept.busy_minutes) ?? 0,
        valueText: fmtMinutes(num(dept.busy_minutes)),
        color: paletteColor(DEPT_ORDER.includes(dept.dept) ? deptIndex(dept.dept) : i),
      }))
      .filter((x) => x.value > 0);
    const totalBusy = items.reduce((s, x) => s + x.value, 0);
    add(
      block,
      donutBlock(items, {
        centerValue: fmtHoursShort(totalBusy),
        centerLabel: '合計の稼動',
        ariaLabel: '部署別の稼動分シェア',
        emptyText: 'この期間に稼動した部署はありません',
      }),
    );
    add(section, block);
  }

  // 役職別 top
  const roles = objs(a.roles).slice(0, 12);
  const roleBlock = h('div', 'view-block');
  add(roleBlock, subHeading('役職別の稼動（多い順）'));
  if (roles.length === 0) {
    add(roleBlock, emptyState('役職別の稼動データがまだありません'));
  } else {
    const items = roles.map((r) => {
      const busy = num(r.busy_minutes);
      const runs = num(r.runs);
      const fail = num(r.fail);
      return {
        label: str(r.role) ? roleLabel(r.role) : '不明',
        value: busy ?? 0,
        valueText: fmtMinutes(busy),
        sub: `${runs === null ? '回数 未取得' : fmtCount(runs)}${fail !== null && fail > 0 ? `・失敗${fail}` : ''}`,
        color: paletteColor(deptIndex(r.dept ?? deptOfRole(r.role))),
      };
    });
    const max = Math.max(1, ...items.map((x) => x.value));
    const chart = tryChart(() => hbar(items, { max, ariaLabel: '役職別の稼動時間' }));
    const wrap = h('div', 'view-chart view-chart--bars');
    add(wrap, chart ?? emptyState('役職別の稼動データがまだありません'));
    add(roleBlock, wrap);
  }
  add(section, roleBlock);

  const nonLlm = num(a.non_llm_runs);
  if (nonLlm !== null) {
    add(section, h('p', 'view-footnote', `LLM を使わない実行（巡回・心拍など）が ${nonLlm} 件ありました。上の回数・稼動分には含めていません。`));
  } else if (a.non_llm_runs === null) {
    add(section, h('p', 'view-footnote', 'LLM を使わない実行の件数: 未取得'));
  }
  return section;
}

// ---------------------------------------------------------------------------
// モデル別稼動

function modelItems(m) {
  return objs(m.items).filter((x) => str(x.model));
}

function activeCooling(list, now) {
  const nowMs = nowMsOf(now);
  return objs(list).filter((c) => {
    if (!str(c.route)) return false;
    const until = parseTime(c.until);
    return until === null || until.getTime() > nowMs;
  });
}

function coolingLine(c, now) {
  const until = parseTime(c.until);
  const nowMs = nowMsOf(now);
  let when = '時刻不明';
  if (until) {
    const within = until.getTime() - nowMs < 12 * HOUR_MS;
    when = within ? formatTimeJa(until) : formatDateTimeJa(until);
  }
  const reason = str(c.reason);
  return `${c.route}は${when}まで停止中${reason ? `: ${reason}` : ''}`;
}

export function renderModelsSection(data, now) {
  const d = isObj(data) ? data : {};
  const m = isObj(d.models) ? d.models : null;
  const win = num(m?.window_hours) ?? 24;
  const section = makeSection('models', 'view-models', 'モデル別の稼動', `直近${win}時間・LLM を使った実行のみ`);
  if (!m) {
    add(section, emptyState());
    return section;
  }

  // クールダウン（models.cooling、無ければ ops.cooling_routes）
  const coolingSource = Array.isArray(m.cooling) ? m.cooling : Array.isArray(d.ops?.cooling_routes) ? d.ops.cooling_routes : null;
  if (coolingSource !== null) {
    const cooling = activeCooling(coolingSource, now);
    if (cooling.length > 0) {
      const box = h('div', 'view-alert');
      add(box, h('p', 'view-alert-title', '一時停止中の経路'));
      const ul = h('ul', 'view-alert-list');
      for (const c of cooling) add(ul, h('li', 'view-alert-item', coolingLine(c, now)));
      add(box, ul);
      add(section, box);
    } else {
      add(section, h('p', 'view-okline', '停止中の経路はありません'));
    }
  }

  const items = modelItems(m);
  if (items.length === 0) {
    add(section, emptyState('この期間にモデルを使った実行はありません'));
    return section;
  }

  const totalRuns = items.reduce((s, x) => s + (num(x.runs) ?? 0), 0);
  const donutItems = items.map((x, i) => ({
    label: `${x.model}${x.metered === true ? '（従量）' : ''}`,
    value: num(x.runs) ?? 0,
    valueText: fmtCount(num(x.runs) ?? 0),
    color: paletteColor(i),
  }));

  const block = h('div', 'view-block');
  add(block, subHeading('実行回数のシェア'));
  add(
    block,
    donutBlock(donutItems, {
      centerValue: `${totalRuns}`,
      centerLabel: '実行回数',
      ariaLabel: 'モデル別の実行回数シェア',
      emptyText: '実行回数を集計できませんでした',
    }),
  );
  add(section, block);

  // 詳細リスト（従量印・成功/失敗・経路）
  const list = h('ul', 'view-model-list');
  items.forEach((x, i) => {
    const li = h('li', 'view-model-row');
    const top = h('div', 'view-model-top');
    add(top, h('span', `view-dot view-bg${(i % 8) + 1}`));
    add(top, h('span', 'view-model-name', x.model));
    if (x.metered === true) add(top, h('span', 'view-badge view-badge--warn', '従量'));
    else if (x.metered === false) add(top, h('span', 'view-badge', '定額・無料'));
    add(li, top);
    const runs = num(x.runs);
    const ok = num(x.ok);
    const fail = num(x.fail);
    add(
      li,
      h(
        'p',
        'view-model-meta',
        `${runs === null ? '回数 未取得' : fmtCount(runs)}（成功 ${ok === null ? '未取得' : ok} / 失敗 ${fail === null ? '未取得' : fail}）`,
      ),
    );
    if (str(x.route)) add(li, h('p', 'view-model-route', x.route));
    add(list, li);
  });
  add(section, list);

  // 稼動分・費用の横棒
  const split = h('div', 'view-split');
  const busyItems = items.map((x, i) => {
    const busy = num(x.busy_minutes);
    return { label: x.model, value: busy ?? 0, valueText: fmtMinutes(busy), color: paletteColor(i) };
  });
  const busyBlock = h('div', 'view-block');
  add(busyBlock, subHeading('稼動分'));
  const busyChart = tryChart(() =>
    hbar(busyItems, { max: Math.max(1, ...busyItems.map((x) => x.value)), ariaLabel: 'モデル別の稼動時間' }),
  );
  const busyWrap = h('div', 'view-chart view-chart--bars');
  add(busyWrap, busyChart ?? emptyState('稼動分を集計できませんでした'));
  add(busyBlock, busyWrap);
  add(split, busyBlock);

  const costItems = items.map((x, i) => {
    const cost = num(x.cost_usd);
    return {
      label: x.model,
      value: cost ?? 0,
      valueText: cost === null ? '未取得' : formatUsd(cost),
      color: paletteColor(i),
    };
  });
  const costBlock = h('div', 'view-block');
  add(costBlock, subHeading('費用', '従量のモデルだけ費用が発生します'));
  const costChart = tryChart(() =>
    hbar(costItems, { max: Math.max(0.01, ...costItems.map((x) => x.value)), ariaLabel: 'モデル別の費用' }),
  );
  const costWrap = h('div', 'view-chart view-chart--bars');
  add(costWrap, costChart ?? emptyState('費用を集計できませんでした'));
  add(costBlock, costWrap);
  add(split, costBlock);
  add(section, split);
  return section;
}

// ---------------------------------------------------------------------------
// 費用

function dailyPoints(list) {
  const out = [];
  for (const p of objs(list)) {
    const usd = num(p.usd);
    const date = str(p.date);
    if (usd === null || date === null) continue;
    out.push({ label: date.length >= 10 ? date.slice(5, 10).replace('-', '/') : date, value: usd });
  }
  return out;
}

function statBox(label, value, note, tone) {
  const box = h('div', `view-stat${tone ? ` view-stat--${tone}` : ''}`);
  add(box, h('p', 'view-stat-label', label));
  add(box, h('p', 'view-stat-value', value));
  if (note) add(box, h('p', 'view-stat-note', note));
  return box;
}

function deficitBlock(f) {
  const block = h('div', 'view-block view-deficit');
  add(block, subHeading('赤字（支出 − 売上）'));
  const spent = num(f.spent_total_usd);
  const deficit = num(f.deficit_usd);
  if (spent === null && deficit === null && f.revenue_usd === undefined) {
    add(block, emptyState());
    return block;
  }
  const revenueMissing = f.revenue_usd === null || f.revenue_usd === undefined;
  const revenue = num(f.revenue_usd);
  const eq = h('div', 'view-equation');
  add(eq, statBox('支出の累計', spent === null ? '未取得' : formatUsd(spent), null, null));
  add(eq, h('span', 'view-op', '−'));
  if (revenueMissing || revenue === null) {
    add(eq, statBox('売上', '未接続', str(f.revenue_missing_reason) ?? '売上データは未接続です', 'muted'));
  } else {
    add(eq, statBox('売上', formatUsd(revenue), null, 'ok'));
  }
  add(eq, h('span', 'view-op', '＝'));
  add(
    eq,
    statBox('赤字', deficit === null ? '未取得' : formatUsd(deficit), null, deficit !== null && deficit > 0 ? 'warn' : deficit === 0 ? 'ok' : 'muted'),
  );
  add(block, eq);
  if (str(f.deficit_basis)) add(block, h('p', 'view-footnote', f.deficit_basis));
  return block;
}

function monthBlock(f) {
  const block = h('div', 'view-block');
  add(block, subHeading('月末の見込み と 月の上限'));
  const monthUsd = num(f.month_usd);
  const projected = num(f.projected_month_usd);
  const monthCap = num(f.month_cap_usd);
  if (monthUsd === null && projected === null && monthCap === null) {
    add(block, emptyState());
    return block;
  }
  const items = [];
  if (monthUsd !== null) {
    const pct = fmtPct(monthUsd, monthCap);
    items.push({ label: '今月の実績', value: monthUsd, valueText: `${formatUsd(monthUsd)}${pct ? `（${pct}）` : ''}`, color: paletteColor(0) });
  }
  if (projected !== null) {
    const pct = fmtPct(projected, monthCap);
    items.push({
      label: '月末の見込み',
      value: projected,
      valueText: `${formatUsd(projected)}${pct ? `（${pct}）` : ''}`,
      color: paletteColor(1),
      warn: monthCap !== null && projected > monthCap,
    });
  }
  if (monthCap !== null) {
    items.push({ label: '月の上限', value: monthCap, valueText: formatUsd(monthCap), color: paletteColor(7) });
  }
  const max = Math.max(1, monthCap ?? 0, ...items.map((x) => x.value));
  const chart = tryChart(() => hbar(items, { max, ariaLabel: '今月の実績・月末の見込み・月の上限' }));
  const wrap = h('div', 'view-chart view-chart--bars');
  add(wrap, chart ?? emptyState('月の集計を描けませんでした'));
  add(block, wrap);
  const notes = [];
  if (projected === null) notes.push(missingLine('月末の見込み', '日数が足りないか集計前'));
  if (monthCap === null) notes.push(missingLine('月の上限', '日の上限が未設定'));
  else notes.push('月の上限は 1 日の上限 × 30 日で計算しています。');
  if (projected !== null && monthCap !== null && projected > monthCap) notes.push('見込みが月の上限を超えています。');
  for (const n of notes) add(block, h('p', 'view-footnote', n));
  return block;
}

export function renderFinanceSection(data, now) {
  const section = makeSection('finance', 'view-finance', '費用', '従量 API の支出と収支');
  const d = isObj(data) ? data : {};
  const f = isObj(d.finance) ? d.finance : null;
  if (!f) {
    add(section, emptyState());
    return section;
  }

  // ゲージ + 日次折れ線
  const top = h('div', 'view-split view-split--wide');

  const gaugeBlock = h('div', 'view-block');
  add(gaugeBlock, subHeading('今日の支出 / 上限'));
  const today = num(f.today_usd);
  const cap = num(f.cap_usd);
  const gaugeWrap = h('div', 'view-chart view-chart--gauge');
  const g =
    today !== null && cap !== null && cap > 0
      ? tryChart(() =>
          gauge(today, cap, {
            label: `上限 ${formatUsd(cap)}`,
            valueText: formatUsd(today),
            warnAt: 0.8,
            dangerAt: 1,
            ariaLabel: `今日の支出 ${formatUsd(today)}、上限 ${formatUsd(cap)}`,
          }),
        )
      : null;
  if (g) {
    add(gaugeWrap, g);
  } else if (today === null) {
    add(gaugeWrap, emptyState(missingLine('今日の支出', str(f.missing_reason))));
  } else {
    add(gaugeWrap, h('p', 'view-big', formatUsd(today)));
    add(gaugeWrap, h('p', 'view-empty view-empty--inline', missingLine('上限', '1 日の上限が未設定')));
  }
  add(gaugeBlock, gaugeWrap);
  add(top, gaugeBlock);

  const lineBlock = h('div', 'view-block');
  add(lineBlock, subHeading('直近14日の支出', '1 日ごと（点線は 1 日の上限）'));
  const points = dailyPoints(f.daily);
  const lineWrap = h('div', 'view-chart view-chart--line');
  const line =
    points.length > 0
      ? tryChart(() =>
          lineChart(points, {
            width: 520,
            height: 200,
            refLine: cap !== null ? { value: cap, label: '上限' } : undefined,
            yFormat: (v) => `$${Number(v).toFixed(2)}`,
            ariaLabel: '直近14日の日次支出',
          }),
        )
      : null;
  add(lineWrap, line ?? emptyState(Array.isArray(f.daily) ? '日次の記録がまだありません' : MISSING_TEXT));
  add(lineBlock, lineWrap);
  add(top, lineBlock);
  add(section, top);

  // ルート別
  const routeBlock = h('div', 'view-block');
  add(routeBlock, subHeading('経路別の支出（今月）'));
  const entries = numericEntries(f.by_route);
  const routeItems = entries.map(([name, value], i) => ({
    label: name,
    value,
    valueText: formatUsd(value),
    color: paletteColor(i),
  }));
  add(
    routeBlock,
    donutBlock(routeItems, {
      centerValue: formatUsd(routeItems.reduce((s, x) => s + x.value, 0)),
      centerLabel: '今月の合計',
      ariaLabel: '経路別の支出',
      emptyText: '経路別の支出はまだありません',
    }),
  );
  add(section, routeBlock);

  const bottom = h('div', 'view-split view-split--wide');
  add(bottom, deficitBlock(f));
  add(bottom, monthBlock(f));
  add(section, bottom);
  return section;
}
