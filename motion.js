// dashboard/motion.js — ダッシュボードに「動き」を足す後付けレイヤー（依存ゼロ・ES module）
//
// 方針:
//  - 既存の描画（app.js / views.js / board.js）は一切変えない。描画が終わった DOM に対して
//    クラスと CSS 変数を足し、Web Animations API で図表を描き込むだけ。
//  - 動きが無くても全情報が読めること（プログレッシブ・エンハンスメント）。
//    IntersectionObserver / Element.animate が無い環境、prefers-reduced-motion のときは何もしない。
//  - データを innerHTML に入れない。数字は textContent の書き換えだけ。
//  - テストの最小 DOM シャドウでも例外を出さない（document.querySelectorAll が無ければ即 return）。
//
// 動きの設計（Microsoft Fluent のモーション指針に寄せる）:
//  - 入場は decelerate（急に出て、ゆっくり止まる）。時間は 200〜400ms 台。
//  - 数字は 0 → 実値へカウントアップ。グラフは線・弧・バーを「描き込む」。
//  - 並びのある要素は 45ms ずつずらして登場（stagger）。

/** 数字として動かせる文字列か。前置き・数字・小数・後置きが 1 組だけのものに限る。 */
export function parseCountable(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\D*?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\D*)$/.exec(text.trim());
  if (!m) return null;
  const [, prefix, intPart, frac, suffix] = m;
  const comma = intPart.includes(',');
  const decimals = frac ? frac.length - 1 : 0;
  const value = Number(intPart.replace(/,/g, '') + (frac ?? ''));
  if (!Number.isFinite(value)) return null;
  return { prefix, suffix, comma, decimals, value };
}

/** 進捗 0〜1 のときの表示文字列。progress=1 で元の文字列と一致する。 */
export function formatCount(parsed, progress) {
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  const v = parsed.value * p;
  let body = v.toFixed(parsed.decimals);
  if (parsed.comma) {
    const [i, f] = body.split('.');
    body = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : '');
  }
  return `${parsed.prefix}${body}${parsed.suffix}`;
}

/** easeOutExpo。最初に勢いよく、最後にぴたっと止まる。 */
export function easeOutExpo(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return 1 - 2 ** (-10 * t);
}

const EASE = 'cubic-bezier(0, 0, 0, 1)'; // Fluent curveDecelerateMid
const COUNT_MS = 900;
const STAGGER_MS = 45;

// 数字を動かす対象（textContent が数字だけのもの）。
const COUNT_SELECTOR = [
  '.view-tile-value',
  '.view-stat-value',
  '.chart-donut-value',
  '.view-dept-runs-num',
  '.board-column-count',
].join(',');

// 子要素を順番にずらして登場させるグループ（親 → 子）。
const STAGGER_GROUPS = [
  ['.view-tiles', ':scope > *'],
  ['.view-cards', ':scope > *'],
  ['.board-columns', ':scope > *'],
  ['.ops-grid', ':scope > *'],
  ['.dept-list', ':scope > *'],
  ['.kanban', ':scope > *'],
  ['.view-model-list', ':scope > *'],
  ['.chart-legend', ':scope > *'],
  ['.view-split', ':scope > *'],
  ['.task-list', ':scope > *'],
];

// スポットライト（ポインタ追従のハイライト）を付けるカード。
const SPOT_SELECTOR = '.view-tile, .view-card, .board-card, .dept-card, .app, .kanban-col, .stat';

let teardown = null;

function reducedMotion() {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function supported() {
  return (
    typeof document !== 'undefined' &&
    typeof document.querySelectorAll === 'function' &&
    typeof window !== 'undefined' &&
    typeof window.IntersectionObserver === 'function'
  );
}

function canAnimate(node) {
  return node && typeof node.animate === 'function';
}

function animateCount(node, parsed) {
  const start = performance.now();
  let raf = 0;
  function frame(now) {
    const t = Math.min(1, (now - start) / COUNT_MS);
    node.textContent = formatCount(parsed, easeOutExpo(t));
    if (t < 1) raf = window.requestAnimationFrame(frame);
  }
  node.textContent = formatCount(parsed, 0);
  raf = window.requestAnimationFrame(frame);
  return () => {
    window.cancelAnimationFrame(raf);
  };
}

/** セクションの中の SVG 図表を「描き込む」。 */
function drawCharts(section, delay) {
  const run = (node, frames, options) => {
    if (!canAnimate(node)) return;
    try {
      node.animate(frames, { duration: 700, easing: EASE, fill: 'backwards', delay, ...options });
    } catch {
      /* 古い環境では何もしない */
    }
  };

  // ドーナツ: 弧を伸ばす。
  section.querySelectorAll('.chart-donut-segment').forEach((seg, i) => {
    const dash = seg.getAttribute('stroke-dasharray');
    if (!dash) {
      run(seg, [{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: delay + i * 60 });
      return;
    }
    const parts = dash.split(/[\s,]+/).map(Number);
    const total = (parts[0] || 0) + (parts[1] || 0);
    run(seg, [{ strokeDasharray: `0 ${total}` }, { strokeDasharray: dash }], {
      duration: 800,
      delay: delay + i * 90,
    });
  });

  // 横棒: 左から伸ばす。
  section.querySelectorAll('.chart-hbar-fill').forEach((bar, i) => {
    bar.style.transformBox = 'fill-box';
    bar.style.transformOrigin = 'left center';
    run(bar, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { delay: delay + i * 50 });
  });

  // 折れ線・スパークライン・ゲージ: pathLength=1 に正規化して描き込む。
  section.querySelectorAll('.chart-line-path, .chart-spark-line, .chart-gauge-fill').forEach((path, i) => {
    path.setAttribute('pathLength', '1');
    run(
      path,
      [
        { strokeDasharray: '1 1', strokeDashoffset: 1 },
        { strokeDasharray: '1 1', strokeDashoffset: 0 },
      ],
      { duration: 900, delay: delay + i * 60 },
    );
  });
  section.querySelectorAll('.chart-spark-area').forEach((area) => {
    run(area, [{ opacity: 0 }, { opacity: 1 }], { duration: 700, delay: delay + 300 });
  });
  section.querySelectorAll('.chart-line-dot, .chart-spark-dot').forEach((dot, i) => {
    run(dot, [{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: delay + 500 + Math.min(i, 20) * 25 });
  });

  // ヒートマップ: 左から順に点灯。
  section.querySelectorAll('.chart-heat-cell').forEach((cell, i) => {
    run(cell, [{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: delay + Math.min(i, 48) * 14 });
  });
}

function tagStagger(root) {
  for (const [parentSel, childSel] of STAGGER_GROUPS) {
    root.querySelectorAll(parentSel).forEach((parent) => {
      let kids;
      try {
        kids = parent.querySelectorAll(childSel);
      } catch {
        kids = parent.children ?? [];
      }
      let i = 0;
      kids.forEach((kid) => {
        kid.classList.add('mo-item');
        kid.style.setProperty('--i', String(Math.min(i, 12)));
        i += 1;
      });
    });
  }
}

/** 左ナビ: いま画面の上端にあるセクションのリンクを強調する(スクロールスパイ)。 */
function updateNavSpy(sections) {
  const links = Array.from(document.querySelectorAll('.side-nav a'));
  if (links.length === 0) return;
  let current = null;
  for (const section of sections) {
    if (!section.id) continue;
    if (section.getBoundingClientRect().top <= 120) current = section.id;
  }
  const first = sections.find((s) => s.id);
  if (!current && first) current = first.id;
  for (const link of links) {
    const on = link.getAttribute('href') === `#${current}`;
    if (on === link.classList.contains('is-active')) continue;
    if (on) {
      link.classList.add('is-active');
      link.setAttribute('aria-current', 'location');
    } else {
      link.classList.remove('is-active');
      link.removeAttribute('aria-current');
    }
  }
}

/**
 * 描画済みの #dashboard に動きを付ける。何度呼んでもよい（前回分は片付ける）。
 * @param {Element} root 通常は #dashboard
 * @returns {() => void} 片付け関数
 */
export function enhance(root) {
  disable();
  if (!root || !supported()) return () => {};

  const doc = document.documentElement;
  const sections = Array.from(root.children ?? []);

  // 動きを止めたい環境では、全部見える状態のままにする。
  if (reducedMotion()) {
    doc?.classList?.add('mo-reduced');
    return () => doc?.classList?.remove('mo-reduced');
  }

  tagStagger(root);
  const cancels = [];

  const io = new window.IntersectionObserver(
    (entries) => {
      // 同じタイミングで見えたものは、上にあるものから順に少しずらす。
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      visible.forEach((entry, order) => {
        const section = entry.target;
        io.unobserve(section);
        const delay = order * 90;
        section.style.setProperty('--mo-delay', `${delay}ms`);
        section.classList.add('mo-in');
        drawCharts(section, delay + 120);
        section.querySelectorAll(COUNT_SELECTOR).forEach((node) => {
          const original = node.textContent;
          const parsed = parseCountable(original);
          if (!parsed || parsed.value === 0) return;
          node.setAttribute('aria-label', original.trim());
          const timer = window.setTimeout(() => {
            cancels.push(animateCount(node, parsed));
            // 念のため、最後は必ず元の文字列に戻す。
            window.setTimeout(() => {
              node.textContent = original;
            }, COUNT_MS + 80);
          }, delay + 160);
          cancels.push(() => window.clearTimeout(timer));
        });
      });
    },
    { threshold: 0.08, rootMargin: '0px 0px -6% 0px' },
  );

  for (const section of sections) {
    section.classList.add('mo-reveal');
    io.observe(section);
  }
  doc?.classList?.add('mo-on');

  // ---- スクロール進捗バー（画面上端の細い金色の線）
  let bar = null;
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      ticking = false;
      const max = (document.documentElement.scrollHeight || 0) - (window.innerHeight || 0);
      const p = max > 0 ? Math.min(1, Math.max(0, (window.scrollY || 0) / max)) : 0;
      bar?.style.setProperty('--mo-progress', p.toFixed(4));
      updateNavSpy(sections);
    });
  };
  if (document.body && typeof document.createElement === 'function') {
    bar = document.createElement('div');
    bar.className = 'mo-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.append(bar);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---- ポインタ追従のスポットライト（Fluent の Reveal ハイライト）
  let spotRaf = 0;
  const onMove = (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const card = target.closest(SPOT_SELECTOR);
    if (!card) return;
    if (spotRaf) return;
    spotRaf = window.requestAnimationFrame(() => {
      spotRaf = 0;
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${(event.clientX - rect.left).toFixed(0)}px`);
      card.style.setProperty('--my', `${(event.clientY - rect.top).toFixed(0)}px`);
    });
  };
  root.addEventListener('pointermove', onMove, { passive: true });

  teardown = () => {
    io.disconnect();
    for (const cancel of cancels) cancel();
    window.removeEventListener('scroll', onScroll);
    root.removeEventListener?.('pointermove', onMove);
    if (spotRaf) window.cancelAnimationFrame(spotRaf);
    bar?.remove?.();
    document.querySelectorAll('.side-nav a.is-active').forEach((a) => a.classList.remove('is-active'));
    doc?.classList?.remove('mo-on', 'mo-reduced');
  };
  return disable;
}

/** 付けた動きを片付ける（ロック時・再描画前）。 */
export function disable() {
  if (teardown) {
    const fn = teardown;
    teardown = null;
    try {
      fn();
    } catch {
      /* 片付けの失敗は無視 */
    }
  }
}
