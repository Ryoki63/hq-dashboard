// dashboard/theme.js — ライト / ダークの切り替え。
// 方針: 保存値（light|dark）があればそれ、無ければ OS の設定に従う。結果は常に
//       <html data-theme="light|dark"> として CSS に渡す（CSS 側は属性だけを見る）。
// 保存先は localStorage（秘密ではない表示設定のみ。トークンやパスフレーズは入れない）。

export const THEME_KEY = 'hq-dashboard-theme';

/** 保存値と OS 設定から、実際に使うテーマを決める。 */
export function resolveTheme(stored, prefersDark) {
  if (stored === 'light' || stored === 'dark') return stored;
  return prefersDark ? 'dark' : 'light';
}

export function nextTheme(current) {
  return current === 'dark' ? 'light' : 'dark';
}

function readStored() {
  try {
    return window.localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    window.localStorage.setItem(THEME_KEY, value);
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

function osPrefersDark() {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function apply(theme, button) {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (root && typeof root.setAttribute === 'function') root.setAttribute('data-theme', theme);
  if (button) {
    button.textContent = theme === 'dark' ? 'ライト' : 'ダーク';
    button.setAttribute('aria-label', theme === 'dark' ? 'ライトモードに切り替える' : 'ダークモードに切り替える');
    button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  }
  return theme;
}

/** 起動時に 1 回呼ぶ。ボタンがあれば切り替えを結びつける。DOM が無い環境では何もしない。 */
export function initTheme(button) {
  if (typeof document === 'undefined' || !document.documentElement) return 'light';
  let theme = apply(resolveTheme(readStored(), osPrefersDark()), button);
  if (button && typeof button.addEventListener === 'function') {
    button.addEventListener('click', () => {
      theme = apply(nextTheme(theme), button);
      writeStored(theme);
    });
  }
  return theme;
}
