// dashboard/charts.js
//
// 依存ゼロの素の SVG 描画ライブラリ(ブラウザ ES module)。
// 規約: インライン style / <style> / innerHTML は使わない(CSP: style-src 'self')。
//       テキストは textContent、色は fill="var(--c3)" のように属性へ直接書く。
//       すべての SVG は role="img" と <title> と aria-label を持つ。
//       描けない入力(空・全 0・非有限数)は、契約どおり null を返す関数と
//       空の要素を返す関数に分ける(下の各関数コメント参照)。

const SVG_NS = 'http://www.w3.org/2000/svg';

export const PALETTE_SIZE = 8;

// ---------------------------------------------------------------- helpers

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 正の有限数ならそのまま、そうでなければ既定値。 */
function dim(v, fallback) {
  return isNum(v) && v > 0 ? v : fallback;
}

/** 座標用に小数 2 桁へ丸める(属性文字列を短く保つ)。 */
function r2(v) {
  return Math.round(v * 100) / 100;
}

/** 表示用の数値整形。ロケール非依存。 */
function fmtNum(v) {
  if (!isNum(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

function fmtPct(v, total) {
  if (!isNum(v) || !isNum(total) || total <= 0) return '';
  const pct = (v / total) * 100;
  if (pct > 0 && pct < 0.05) return '<0.1%';
  return String(Number(pct.toFixed(1))) + '%';
}

/** 負数・非有限は 0 扱いの「描画に使える量」。 */
function amount(v) {
  return isNum(v) && v > 0 ? v : 0;
}

function textOf(v) {
  return v === null || v === undefined ? '' : String(v);
}

function svgEl(name, attrs, children) {
  const node = document.createElementNS(SVG_NS, name);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value === null || value === undefined) continue;
      node.setAttribute(key, typeof value === 'number' ? String(r2(value)) : String(value));
    }
  }
  if (children) {
    for (const child of children) if (child) node.appendChild(child);
  }
  return node;
}

function svgText(content, attrs) {
  const node = svgEl('text', attrs);
  node.textContent = textOf(content);
  return node;
}

function titleEl(content) {
  const node = svgEl('title');
  node.textContent = textOf(content);
  return node;
}

/** role="img" + <title> + aria-label を備えた SVG ルート。 */
function svgRoot(width, height, label, className) {
  const root = svgEl('svg', {
    class: className,
    width,
    height,
    viewBox: '0 0 ' + r2(width) + ' ' + r2(height),
    role: 'img',
    'aria-label': label,
    focusable: 'false',
  });
  root.appendChild(titleEl(label));
  return root;
}

function htmlEl(name, className) {
  const node = document.createElement(name);
  if (className) node.className = className;
  return node;
}

function itemColor(item, index) {
  return item && typeof item.color === 'string' && item.color !== '' ? item.color : paletteColor(index);
}

/**
 * 値の列を「連続した有効値の区間」に分ける(null / NaN で線を切る)。
 * 返り値: [[{i, x, y}, …], …]
 */
function buildRuns(values, xAt, yAt) {
  const runs = [];
  let current = null;
  values.forEach((v, i) => {
    if (isNum(v)) {
      if (!current) {
        current = [];
        runs.push(current);
      }
      current.push({ i, x: xAt(i), y: yAt(v) });
    } else {
      current = null;
    }
  });
  return runs;
}

function linePath(run) {
  return run.map((p, k) => (k === 0 ? 'M' : 'L') + r2(p.x) + ' ' + r2(p.y)).join(' ');
}

function areaPath(run, baseY) {
  const first = run[0];
  const last = run[run.length - 1];
  return linePath(run) + ' L' + r2(last.x) + ' ' + r2(baseY) + ' L' + r2(first.x) + ' ' + r2(baseY) + ' Z';
}

// ---------------------------------------------------------------- palette

/** i 番目のデータ色。負数・小数・NaN でも常に --c1..--c8 のどれかを返す。 */
export function paletteColor(i) {
  const n = isNum(i) ? Math.floor(i) : 0;
  const idx = ((n % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE;
  return 'var(--c' + (idx + 1) + ')';
}

// ---------------------------------------------------------------- donut

/**
 * ドーナツ。stroke-dasharray 方式(円周上の弧)。
 * 値が正の項目だけを描く。合計が 0 / 空 / 全 null のときは null。
 * 1 項目が 100% のときは dasharray を使わず円をそのまま描き、
 * 極小項目は最低 1px の弧を確保する。
 */
export function donut(items, opts) {
  const o = opts || {};
  const list = Array.isArray(items) ? items : [];
  const segs = [];
  list.forEach((item, i) => {
    const v = amount(item && item.value);
    if (v > 0) segs.push({ item, index: i, v });
  });
  const total = segs.reduce((s, x) => s + x.v, 0);
  if (!(total > 0) || !Number.isFinite(total)) return null;

  const size = dim(o.size, 160);
  const thickness = clamp(dim(o.thickness, 26), 1, size / 2);
  const cx = size / 2;
  const cy = size / 2;
  const radius = (size - thickness) / 2;
  const circ = 2 * Math.PI * radius;

  const summary = segs
    .map((s) => textOf(s.item.label) + ' ' + fmtPct(s.v, total))
    .join('、');
  const label = o.ariaLabel ? String(o.ariaLabel) : 'ドーナツグラフ: ' + summary;
  const root = svgRoot(size, size, label, 'chart-donut');

  let offset = 0;
  for (const seg of segs) {
    const color = itemColor(seg.item, seg.index);
    const tip = textOf(seg.item.label) + ': ' + fmtNum(seg.v) + ' (' + fmtPct(seg.v, total) + ')';
    const attrs = {
      class: 'chart-donut-segment',
      cx,
      cy,
      r: radius,
      fill: 'none',
      stroke: color,
      'stroke-width': thickness,
    };
    if (segs.length > 1) {
      const len = clamp((seg.v / total) * circ, Math.min(1, circ), circ);
      attrs['stroke-dasharray'] = r2(len) + ' ' + r2(Math.max(circ - len, 0));
      attrs['stroke-dashoffset'] = r2(-offset);
      attrs.transform = 'rotate(-90 ' + r2(cx) + ' ' + r2(cy) + ')';
      offset += (seg.v / total) * circ;
    }
    root.appendChild(svgEl('circle', attrs, [titleEl(tip)]));
  }

  const hasValue = o.centerValue !== undefined && o.centerValue !== null && o.centerValue !== '';
  const hasLabel = o.centerLabel !== undefined && o.centerLabel !== null && o.centerLabel !== '';
  if (hasValue) {
    root.appendChild(
      svgText(o.centerValue, {
        class: 'chart-donut-value',
        x: cx,
        y: hasLabel ? cy - size * 0.01 : cy + size * 0.055,
        'text-anchor': 'middle',
        'font-size': r2(size * 0.15),
        'font-weight': '700',
        fill: 'var(--heading, var(--text, #222))',
      }),
    );
  }
  if (hasLabel) {
    root.appendChild(
      svgText(o.centerLabel, {
        class: 'chart-donut-label',
        x: cx,
        y: hasValue ? cy + size * 0.12 : cy + size * 0.04,
        'text-anchor': 'middle',
        'font-size': r2(Math.max(size * 0.075, 9)),
        fill: 'var(--muted, #6b6b6b)',
      }),
    );
  }
  return root;
}

// ---------------------------------------------------------------- legend

/**
 * 凡例 <ul class="chart-legend">。色の丸(SVG)+ラベル+値(+%)。
 * 空 / 非配列でも例外にせず、子の無い <ul> を返す(呼び出し側が append しても安全)。
 * % は opts.total(省略時は正の値の合計)に対する割合。value が null の項目は「—」で % なし。
 * 色は donut と同じく items 内の位置(index)で決まるので、同じ配列を渡せば色が揃う。
 */
export function legend(items, opts) {
  const o = opts || {};
  const list = Array.isArray(items) ? items : [];
  const ul = htmlEl('ul', 'chart-legend');
  const total = isNum(o.total) ? o.total : list.reduce((s, it) => s + amount(it && it.value), 0);
  const showPercent = o.showPercent !== false;

  list.forEach((item, i) => {
    if (!item) return;
    const li = htmlEl('li', 'chart-legend-item');
    const color = itemColor(item, i);
    const swatch = svgEl(
      'svg',
      { class: 'chart-legend-swatch', width: 10, height: 10, viewBox: '0 0 10 10', 'aria-hidden': 'true', focusable: 'false' },
      [svgEl('circle', { cx: 5, cy: 5, r: 5, fill: color })],
    );
    li.appendChild(swatch);

    const name = htmlEl('span', 'chart-legend-label');
    name.textContent = textOf(item.label);
    li.appendChild(name);

    const hasValue = isNum(item.value);
    const valueText =
      item.valueText !== undefined && item.valueText !== null ? String(item.valueText) : hasValue ? fmtNum(item.value) : '—';
    const val = htmlEl('span', 'chart-legend-value');
    val.textContent = valueText;
    li.appendChild(val);

    if (showPercent && hasValue && total > 0) {
      const pct = htmlEl('span', 'chart-legend-pct');
      pct.textContent = fmtPct(Math.max(item.value, 0), total);
      li.appendChild(pct);
    }
    ul.appendChild(li);
  });
  return ul;
}

// ---------------------------------------------------------------- hbar

/**
 * 横棒の縦並び <div class="chart-hbar">。各行 <div class="chart-hbar-row"> は
 * ラベル(+sub)/ 棒(<svg><rect>、幅は viewBox 0..100 の rect width 属性)/ 値。
 * max 省略時は正の値の最大。max<=0 / 全 0 / null のとき棒は 0 幅(行は残す)。
 * 空 / 非配列は子の無い <div> を返す。warn:true の行は棒が警告色 + 行に --warn クラス。
 */
export function hbar(items, opts) {
  const o = opts || {};
  const list = Array.isArray(items) ? items : [];
  const root = htmlEl('div', 'chart-hbar');
  root.setAttribute('role', 'list');
  if (o.ariaLabel) root.setAttribute('aria-label', String(o.ariaLabel));

  const maxValue = isNum(o.max) ? o.max : list.reduce((m, it) => Math.max(m, amount(it && it.value)), 0);

  list.forEach((item, i) => {
    if (!item) return;
    const hasValue = isNum(item.value);
    const ratio = hasValue && maxValue > 0 ? clamp(item.value / maxValue, 0, 1) : 0;
    const valueText =
      item.valueText !== undefined && item.valueText !== null ? String(item.valueText) : hasValue ? fmtNum(item.value) : '—';
    const row = htmlEl('div', 'chart-hbar-row' + (item.warn ? ' chart-hbar-row--warn' : ''));
    row.setAttribute('role', 'listitem');

    const labelWrap = htmlEl('span', 'chart-hbar-label');
    labelWrap.textContent = textOf(item.label);
    if (item.sub !== undefined && item.sub !== null && item.sub !== '') {
      const sub = htmlEl('span', 'chart-hbar-sub');
      sub.textContent = String(item.sub);
      labelWrap.appendChild(sub);
    }
    row.appendChild(labelWrap);

    const tip = textOf(item.label) + ': ' + valueText;
    const bar = svgRoot(100, 10, tip, 'chart-hbar-bar');
    bar.setAttribute('width', '100%');
    bar.setAttribute('height', '10');
    bar.setAttribute('preserveAspectRatio', 'none');
    bar.appendChild(
      svgEl('rect', { class: 'chart-hbar-track', x: 0, y: 0, width: 100, height: 10, fill: 'var(--line, #e5e5e5)' }),
    );
    bar.appendChild(
      svgEl('rect', {
        class: 'chart-hbar-fill',
        x: 0,
        y: 0,
        width: r2(ratio * 100),
        height: 10,
        fill: item.warn ? 'var(--warn, #d97706)' : itemColor(item, i),
      }),
    );
    row.appendChild(bar);

    const val = htmlEl('span', 'chart-hbar-value');
    val.textContent = valueText;
    row.appendChild(val);
    root.appendChild(row);
  });
  return root;
}

// ---------------------------------------------------------------- sparkline

/**
 * スパークライン。null / NaN は線を切る(区間ごとに別 path)。
 * 孤立した 1 点は小さな円で描く。有効値が 1 件も無い(空・全 null)なら null。
 * 値がすべて同じなら中央の水平線。
 */
export function sparkline(values, opts) {
  const o = opts || {};
  const vals = Array.isArray(values) ? values : [];
  const valid = vals.filter(isNum);
  if (valid.length === 0) return null;

  const width = dim(o.width, 120);
  const height = dim(o.height, 32);
  const pad = Math.min(3, height / 4, width / 4);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const n = vals.length;
  const color = typeof o.color === 'string' && o.color !== '' ? o.color : 'var(--c1)';
  const xAt = (i) => (n === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1));
  const yAt = (v) => (max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - 2 * pad));

  const label = o.ariaLabel
    ? String(o.ariaLabel)
    : '推移(' + valid.length + '点): 最新 ' + fmtNum(valid[valid.length - 1]) + '、最大 ' + fmtNum(max) + '、最小 ' + fmtNum(min);
  const root = svgRoot(width, height, label, 'chart-sparkline');

  const runs = buildRuns(vals, xAt, yAt);
  for (const run of runs) {
    if (run.length === 1) {
      root.appendChild(svgEl('circle', { class: 'chart-spark-dot', cx: run[0].x, cy: run[0].y, r: 1.8, fill: color }));
      continue;
    }
    if (o.area !== false) {
      root.appendChild(
        svgEl('path', { class: 'chart-spark-area', d: areaPath(run, height - pad), fill: color, 'fill-opacity': '0.18', stroke: 'none' }),
      );
    }
    root.appendChild(
      svgEl('path', {
        class: 'chart-spark-line',
        d: linePath(run),
        fill: 'none',
        stroke: color,
        'stroke-width': 1.5,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
  }
  // 最後の有効点に印を付ける。
  const lastRun = runs[runs.length - 1];
  const lastPoint = lastRun[lastRun.length - 1];
  if (lastRun.length > 1) {
    root.appendChild(svgEl('circle', { class: 'chart-spark-last', cx: lastPoint.x, cy: lastPoint.y, r: 2, fill: color }));
  }
  return root;
}

// ---------------------------------------------------------------- lineChart

/**
 * 折れ線。points: [{label, value}]。null / NaN の点は線を切る。
 * 軸ラベル: 縦軸の下端・上端、横軸の最初と最後のラベル、最大値の点に値ラベル。
 * refLine {value,label} があれば破線の参照線(上限など)を引き、縦軸の範囲に含める。
 * 空 / 非配列 / 有効値なしは null。
 */
export function lineChart(points, opts) {
  const o = opts || {};
  const pts = Array.isArray(points) ? points.map((p) => (p && typeof p === 'object' ? p : { label: '', value: null })) : [];
  const vals = pts.map((p) => (isNum(p.value) ? p.value : null));
  const valid = vals.filter((v) => v !== null);
  if (valid.length === 0) return null;

  const width = dim(o.width, 480);
  const height = dim(o.height, 180);
  const fmtY = typeof o.yFormat === 'function' ? o.yFormat : fmtNum;
  const ref = o.refLine && isNum(o.refLine.value) ? o.refLine : null;

  const left = 44;
  const right = 14;
  const top = 18;
  const bottom = 26;
  const plotW = Math.max(width - left - right, 1);
  const plotH = Math.max(height - top - bottom, 1);

  const dataMax = Math.max(...valid);
  const dataMin = Math.min(...valid);
  let yMax = ref ? Math.max(dataMax, ref.value) : dataMax;
  let yMin = Math.min(0, dataMin, ref ? ref.value : 0);
  if (yMax === yMin) yMax = yMin + 1;

  const n = pts.length;
  const xAt = (i) => (n === 1 ? left + plotW / 2 : left + (i * plotW) / (n - 1));
  const yAt = (v) => top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  const firstLabel = textOf(pts[0].label);
  const lastLabel = textOf(pts[n - 1].label);
  const label = o.ariaLabel
    ? String(o.ariaLabel)
    : '折れ線グラフ(' + valid.length + '点): ' + firstLabel + ' から ' + lastLabel + '、最大 ' + fmtY(dataMax) + '、最小 ' + fmtY(dataMin);
  const root = svgRoot(width, height, label, 'chart-line');

  // 枠線(下端・上端の水平グリッド)と縦軸ラベル。
  for (const v of [yMin, yMax]) {
    const y = yAt(v);
    root.appendChild(svgEl('line', { class: 'chart-line-grid', x1: left, x2: left + plotW, y1: y, y2: y, stroke: 'var(--line, #e5e5e5)', 'stroke-width': 1 }));
    root.appendChild(
      svgText(fmtY(v), { class: 'chart-line-ytick', x: left - 6, y: y + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted, #6b6b6b)' }),
    );
  }

  // 参照線(上限など)。
  if (ref) {
    const y = yAt(ref.value);
    root.appendChild(
      svgEl('line', {
        class: 'chart-line-ref',
        x1: left,
        x2: left + plotW,
        y1: y,
        y2: y,
        stroke: 'var(--danger, #c0392b)',
        'stroke-width': 1.5,
        'stroke-dasharray': '5 3',
      }),
    );
    root.appendChild(
      svgText(textOf(ref.label) + ' ' + fmtY(ref.value), {
        class: 'chart-line-reflabel',
        x: left + plotW,
        y: y - 4 < 10 ? y + 12 : y - 4,
        'text-anchor': 'end',
        'font-size': 10,
        fill: 'var(--danger, #c0392b)',
      }),
    );
  }

  // 折れ線本体。
  const runs = buildRuns(vals, xAt, yAt);
  for (const run of runs) {
    if (run.length > 1) {
      root.appendChild(
        svgEl('path', {
          class: 'chart-line-path',
          d: linePath(run),
          fill: 'none',
          stroke: 'var(--c1)',
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        }),
      );
    }
  }
  const showDots = n <= 40;
  runs.forEach((run) => {
    run.forEach((p) => {
      if (!showDots && run.length > 1) return;
      const pt = pts[p.i];
      root.appendChild(
        svgEl('circle', { class: 'chart-line-dot', cx: p.x, cy: p.y, r: 2.5, fill: 'var(--c1)' }, [
          titleEl(textOf(pt.label) + ': ' + fmtY(pt.value)),
        ]),
      );
    });
  });

  // 最大値の点に値ラベル(同値が複数なら最後の点)。
  const maxIndex = vals.lastIndexOf(dataMax);
  const mx = xAt(maxIndex);
  const my = yAt(dataMax);
  const anchor = maxIndex < n / 4 ? 'start' : maxIndex > (3 * n) / 4 ? 'end' : 'middle';
  root.appendChild(
    svgText(fmtY(dataMax), {
      class: 'chart-line-max',
      x: mx,
      y: my - 7 < 10 ? my + 15 : my - 7,
      'text-anchor': anchor,
      'font-size': 10,
      'font-weight': '700',
      fill: 'var(--heading, var(--text, #222))',
    }),
  );

  // 横軸: 最初と最後のラベル。
  const baseY = top + plotH + 16;
  root.appendChild(
    svgText(firstLabel, { class: 'chart-line-xtick chart-line-xtick--first', x: xAt(0), y: baseY, 'text-anchor': n === 1 ? 'middle' : 'start', 'font-size': 10, fill: 'var(--muted, #6b6b6b)' }),
  );
  if (n > 1) {
    root.appendChild(
      svgText(lastLabel, { class: 'chart-line-xtick chart-line-xtick--last', x: xAt(n - 1), y: baseY, 'text-anchor': 'end', 'font-size': 10, fill: 'var(--muted, #6b6b6b)' }),
    );
  }
  return root;
}

// ---------------------------------------------------------------- gauge

/**
 * 半円ゲージ。value/max の比率で弧を塗る(0..1 に丸める)。
 * 比率 >= dangerAt で class chart-gauge--danger、>= warnAt で chart-gauge--warn、
 * それ以外 chart-gauge--ok。max が null / 0 / 負 / 非有限、value が非有限なら null
 * (value が未取得のとき 0% のゲージに見せないため)。
 */
export function gauge(value, max, opts) {
  const o = opts || {};
  if (!isNum(max) || max <= 0 || !isNum(value)) return null;

  const width = dim(o.width, 220);
  const warnAt = isNum(o.warnAt) ? o.warnAt : 0.8;
  const dangerAt = isNum(o.dangerAt) ? o.dangerAt : 1.0;
  const stroke = Math.max(Math.min(width * 0.09, 22), 6);
  const radius = (width - stroke) / 2;
  const cx = width / 2;
  const cy = radius + stroke / 2 + 2;
  const height = cy + 22;

  const rawRatio = value / max;
  const ratio = clamp(rawRatio, 0, 1);
  const state = rawRatio >= dangerAt ? 'danger' : rawRatio >= warnAt ? 'warn' : 'ok';
  const color = state === 'danger' ? 'var(--danger, #c0392b)' : state === 'warn' ? 'var(--warn, #d97706)' : 'var(--ok, #2f8f5b)';

  const valueText = o.valueText !== undefined && o.valueText !== null ? String(o.valueText) : fmtNum(value);
  const label = o.ariaLabel
    ? String(o.ariaLabel)
    : (o.label ? String(o.label) + ': ' : 'ゲージ: ') + valueText + ' / ' + fmtNum(max) + '(' + String(Math.round(rawRatio * 100)) + '%)';
  const root = svgRoot(width, height, label, 'chart-gauge chart-gauge--' + state);

  const x0 = cx - radius;
  const x1 = cx + radius;
  root.appendChild(
    svgEl('path', {
      class: 'chart-gauge-track',
      d: 'M' + r2(x0) + ' ' + r2(cy) + ' A' + r2(radius) + ' ' + r2(radius) + ' 0 0 1 ' + r2(x1) + ' ' + r2(cy),
      fill: 'none',
      stroke: 'var(--line, #e5e5e5)',
      'stroke-width': stroke,
    }),
  );
  if (ratio > 0) {
    const ex = cx - radius * Math.cos(ratio * Math.PI);
    const ey = cy - radius * Math.sin(ratio * Math.PI);
    root.appendChild(
      svgEl('path', {
        class: 'chart-gauge-fill',
        d: 'M' + r2(x0) + ' ' + r2(cy) + ' A' + r2(radius) + ' ' + r2(radius) + ' 0 0 1 ' + r2(ex) + ' ' + r2(ey),
        fill: 'none',
        stroke: color,
        'stroke-width': stroke,
      }),
    );
  }

  root.appendChild(
    svgText(valueText, {
      class: 'chart-gauge-value',
      x: cx,
      y: cy - (o.label ? 20 : 8),
      'text-anchor': 'middle',
      'font-size': r2(Math.max(width * 0.11, 12)),
      'font-weight': '700',
      fill: 'var(--heading, var(--text, #222))',
    }),
  );
  if (o.label) {
    root.appendChild(
      svgText(o.label, { class: 'chart-gauge-label', x: cx, y: cy - 4, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted, #6b6b6b)' }),
    );
  }
  root.appendChild(svgText('0', { class: 'chart-gauge-min', x: x0, y: cy + 16, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted, #6b6b6b)' }));
  root.appendChild(svgText(fmtNum(max), { class: 'chart-gauge-max', x: x1, y: cy + 16, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--muted, #6b6b6b)' }));
  return root;
}

// ---------------------------------------------------------------- heatstrip

/**
 * ヒートストリップ(既定 24 セル = 時間帯)。濃さは --gold の fill-opacity。
 * 値が 0 / null / 負 / NaN のセルは薄い格子(opacity 0.1)で描く。全 0 でも格子は残る。
 * 非配列 / 空は null。要素数が 24 でなくてもその数だけ描く。
 */
export function heatstrip(values, opts) {
  const o = opts || {};
  const vals = Array.isArray(values) ? values : [];
  if (vals.length === 0) return null;

  const cellW = dim(o.cellW, 10);
  const cellH = dim(o.cellH, 18);
  const gap = 1.5;
  const n = vals.length;
  const nums = vals.map(amount);
  const maxValue = isNum(o.max) && o.max > 0 ? o.max : Math.max(...nums);
  const tickH = n === 24 ? 12 : 0;
  const width = n * cellW;
  const height = cellH + tickH;
  const labels = Array.isArray(o.labels) ? o.labels : [];

  const peak = Math.max(...nums);
  const label = o.ariaLabel ? String(o.ariaLabel) : '時間帯別の稼動(' + n + 'セル): 最大 ' + fmtNum(peak);
  const root = svgRoot(width, height, label, 'chart-heat');

  nums.forEach((v, i) => {
    const opacity = v > 0 && maxValue > 0 ? 0.2 + 0.8 * clamp(v / maxValue, 0, 1) : 0.1;
    const name = labels[i] !== undefined && labels[i] !== null ? String(labels[i]) : n === 24 ? i + '時' : String(i + 1);
    root.appendChild(
      svgEl(
        'rect',
        {
          class: v > 0 ? 'chart-heat-cell chart-heat-cell--on' : 'chart-heat-cell',
          x: i * cellW + gap / 2,
          y: 0,
          width: Math.max(cellW - gap, 1),
          height: cellH,
          rx: 1.5,
          fill: 'var(--gold, #DEB143)',
          'fill-opacity': r2(opacity),
        },
        [titleEl(name + ': ' + fmtNum(isNum(vals[i]) ? vals[i] : 0))],
      ),
    );
  });
  if (tickH > 0) {
    for (let i = 0; i < n; i += 6) {
      root.appendChild(
        svgText(i, { class: 'chart-heat-tick', x: i * cellW + gap / 2, y: cellH + 10, 'text-anchor': 'start', 'font-size': 9, fill: 'var(--muted, #6b6b6b)' }),
      );
    }
  }
  return root;
}

// ---------------------------------------------------------------- stepper

/**
 * ステッパー <ol class="chart-stepper">。各 <li> は完了 / 現在 / 未来の 3 状態
 * (chart-step--done / --current / --todo)。色だけに頼らないよう、記号(✓ ● 連番)と
 * title("(完了)" 等)、現在の項目には aria-current="step" を付ける。
 * currentIndex が -1 / null / 範囲外 / 非整数なら全部 todo。
 */
export function stepper(steps, currentIndex, opts) {
  const o = opts || {};
  const list = Array.isArray(steps) ? steps : [];
  const current = Number.isInteger(currentIndex) && currentIndex >= 0 && currentIndex < list.length ? currentIndex : -1;
  const ol = htmlEl('ol', 'chart-stepper');
  if (o.ariaLabel) ol.setAttribute('aria-label', String(o.ariaLabel));

  list.forEach((step, i) => {
    const item = step && typeof step === 'object' ? step : { id: step, label: step };
    const state = current < 0 || i > current ? 'todo' : i === current ? 'current' : 'done';
    const stateText = state === 'done' ? '完了' : state === 'current' ? '現在' : '未着手';
    const name = textOf(item.label !== undefined && item.label !== null ? item.label : item.id);
    const li = htmlEl('li', 'chart-step chart-step--' + state);
    if (item.id !== undefined && item.id !== null) li.setAttribute('data-step', String(item.id));
    li.setAttribute('title', name + '(' + stateText + ')');
    if (state === 'current') li.setAttribute('aria-current', 'step');

    const marker = htmlEl('span', 'chart-step-marker');
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = state === 'done' ? '✓' : state === 'current' ? '●' : String(i + 1);
    li.appendChild(marker);

    const text = htmlEl('span', 'chart-step-label');
    text.textContent = name;
    li.appendChild(text);

    const sr = htmlEl('span', 'chart-step-state');
    sr.textContent = '(' + stateText + ')';
    li.appendChild(sr);
    ol.appendChild(li);
  });
  return ol;
}
