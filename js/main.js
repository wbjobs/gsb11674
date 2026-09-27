import { FontManager, FontStatus } from './font-manager.js';
import { FontStore } from './font-store.js';
import { renderPreview, isFontLikelyApplied } from './preview.js';

const CDN = 'https://cdn.jsdelivr.net/fontsource/fonts';

// ---------------------------------------------------------------- 演示字体配置
// 覆盖异常链路：404、超时、CORS、格式不支持、回退字体缺失、加载顺序（priority）
const FONT_CONFIGS = [
  {
    family: 'Roboto',
    priority: 10,
    sources: [{ url: `${CDN}/roboto@latest/latin-400-normal.woff2`, format: 'woff2' }],
    fallbacks: ['Helvetica Neue', 'sans-serif'],
    sampleText: 'Roboto: The quick brown fox jumps over the lazy dog 0123456789',
  },
  {
    family: 'JetBrains Mono',
    priority: 20,
    sources: [{ url: `${CDN}/jetbrains-mono@latest/latin-400-normal.woff2`, format: 'woff2' }],
    fallbacks: ['ui-monospace', 'monospace'],
    sampleText: 'JetBrains Mono: const answer = 42; // => 0b101010',
  },
  {
    // 第一个源 404，自动降级到同字体的第二个源
    family: 'Fira Code',
    priority: 30,
    sources: [
      { url: `${CDN}/fira-code@latest/latin-404-not-exist.woff2`, format: 'woff2' },
      { url: `${CDN}/fira-code@latest/latin-400-normal.woff2`, format: 'woff2' },
    ],
    fallbacks: ['JetBrains Mono', 'monospace'],
    sampleText: 'Fira Code: first source 404 -> fallback to second source',
  },
  {
    // EOT 格式现代浏览器不支持，降级到 woff2 源
    family: 'Open Sans',
    priority: 40,
    sources: [
      { url: `${CDN}/open-sans@latest/latin-400-normal.eot`, format: 'eot' },
      { url: `${CDN}/open-sans@latest/latin-400-normal.woff2`, format: 'woff2' },
    ],
    fallbacks: ['Roboto', 'sans-serif'],
    sampleText: 'Open Sans: EOT unsupported ->降级到 woff2 源',
  },
  {
    // 超时 1ms，必然触发超时中断，整字回退
    family: 'Lato',
    priority: 50,
    timeout: 1,
    sources: [{ url: `${CDN}/lato@latest/latin-400-normal.woff2`, format: 'woff2' }],
    fallbacks: ['Roboto', 'sans-serif'],
    sampleText: 'Lato: timeout=1ms -> 超时中断 -> 回退链',
  },
  {
    // example.com 无 CORS 头，fetch 被浏览器拦截
    family: 'CorsBlocked',
    priority: 60,
    sources: [{ url: 'https://example.com/fonts/secret-font.woff2', format: 'woff2' }],
    fallbacks: ['Roboto', 'serif'],
    sampleText: 'CorsBlocked: CORS 被拦截 -> 回退到 Roboto',
  },
  {
    // 唯一源 404，且回退链里的 NoSuchFont 未注册也未安装 -> 记录回退字体缺失
    family: 'GhostFont',
    priority: 70,
    sources: [{ url: `${CDN}/ghost-font@latest/latin-400-normal.woff2`, format: 'woff2' }],
    fallbacks: ['NoSuchFont', 'Georgia', 'serif'],
    sampleText: 'GhostFont: 源 404 + 回退字体 NoSuchFont 缺失',
  },
];

// ---------------------------------------------------------------- 初始化

const store = new FontStore();
const manager = new FontManager({
  maxFonts: 20,
  maxConcurrent: 3,
  defaultTimeout: 5000,
  store,
});

const grid = document.getElementById('font-grid');
const logEl = document.getElementById('event-log');
const summaryEl = document.getElementById('summary');
const cards = new Map();

for (const config of FONT_CONFIGS) {
  manager.register(config);
  cards.set(config.family, createCard(config));
}

// ---------------------------------------------------------------- UI：卡片

function createCard(config) {
  const card = document.createElement('div');
  card.className = 'font-card';
  card.innerHTML = `
    <div class="head">
      <span class="family">${config.family}</span>
      <span class="badge">${FontStatus.PENDING}</span>
    </div>
    <div class="meta">
      <div class="row"><span>优先级</span><span>${config.priority}</span></div>
      <div class="row"><span>耗时</span><span data-f="duration">-</span></div>
      <div class="row"><span>生效源</span><span data-f="source">-</span></div>
      <div class="row"><span>使用次数</span><span data-f="usage">0</span></div>
      <div class="row"><span>生效字体栈</span><span data-f="stack">-</span></div>
    </div>
    <ul class="attempts" data-f="attempts"></ul>
    <canvas class="preview" data-f="preview"></canvas>
    <div class="preview-note" data-f="note">等待加载…</div>
  `;
  grid.appendChild(card);
  return card;
}

function field(card, name) {
  return card.querySelector(`[data-f="${name}"]`);
}

function updateCard(record) {
  const card = cards.get(record.family);
  if (!card) return;
  const badge = card.querySelector('.badge');
  badge.textContent = record.status + (record.error ? ` (${record.error})` : '');
  badge.className = `badge ${record.status}`;

  field(card, 'duration').textContent = record.duration != null ? `${record.duration} ms` : '-';
  field(card, 'source').textContent = record.activeSource ? shortUrl(record.activeSource.url) : '-';
  field(card, 'usage').textContent = String(manager.getUsage(record.family));
  field(card, 'stack').textContent = record.effectiveStack || '-';

  const attemptsEl = field(card, 'attempts');
  attemptsEl.innerHTML = record.attempts.map(a => `
    <li class="${a.ok ? 'ok' : 'fail'}">
      ${a.ok ? '✓' : '✗'} ${shortUrl(a.url)} [${a.format}]${a.reason ? ` — ${a.reason}` : ''}${a.duration != null ? ` (${a.duration}ms)` : ''}
    </li>`).join('');
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    return u.hostname + '/…/' + parts[parts.length - 1];
  } catch {
    return url;
  }
}

function renderAllPreviews() {
  for (const record of manager.fonts.values()) {
    const card = cards.get(record.family);
    if (!card) continue;
    const stack = record.effectiveStack || `"${record.family}", sans-serif`;
    renderPreview(field(card, 'preview'), record.sampleText, stack);

    // 把字体栈应用到 DOM 元素（计入使用统计）
    const note = field(card, 'note');
    manager.applyTo(note, record.family);
    note.textContent = record.status === FontStatus.LOADED
      ? `已加载 · 字体${isFontLikelyApplied(record.sampleText, record.family) ? '已生效' : '可能未生效'}`
      : `未加载 · 实际渲染使用回退栈`;
    updateCard(record);
  }
  updateSummary();
}

function updateSummary() {
  const records = [...manager.fonts.values()];
  const loaded = records.filter(r => r.status === FontStatus.LOADED).length;
  const fallback = records.filter(r => r.status === FontStatus.FALLBACK).length;
  summaryEl.textContent = `共 ${records.length} 个字体 · 成功 ${loaded} · 回退 ${fallback} · 回退事件 ${manager.fallbackRecords.length} 条`;
}

// ---------------------------------------------------------------- UI：记录与日志

function logEvent(type, detail) {
  const line = document.createElement('div');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.innerHTML = `<span class="t">${time}</span>[${type}] ${escapeHtml(JSON.stringify(detail))}`;
  logEl.prepend(line);
  while (logEl.children.length > 200) logEl.lastChild.remove();
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function renderFallbackRecords() {
  const list = document.getElementById('fallback-list');
  const records = await store.getAll('fallbacks').catch(() => manager.fallbackRecords);
  const data = records.length ? records : manager.fallbackRecords;
  list.innerHTML = data.length ? '' : '<p class="empty">暂无回退记录</p>';
  for (const r of data) {
    const item = document.createElement('div');
    item.className = 'record-item';
    item.innerHTML = `
      <b>${r.family}</b> 回退 · 原因 <span class="reason">${r.reason}</span><br>
      请求链: ${r.requested.join(' → ')}<br>
      命中: <span class="resolved">${r.resolved.join(' → ') || '（无，使用 sans-serif）'}</span>
      ${r.missing && r.missing.length ? `<br>缺失: <span class="missing">${r.missing.join(', ')}</span>` : ''}
      <br>生效栈: ${r.effectiveStack} · ${new Date(r.timestamp).toLocaleString('zh-CN')}`;
    list.appendChild(item);
  }
}

async function renderHistory() {
  const list = document.getElementById('history-list');
  const records = await store.getAll('loads', 50).catch(() => []);
  list.innerHTML = records.length ? '' : '<p class="empty">暂无历史记录</p>';
  for (const r of records) {
    const item = document.createElement('div');
    item.className = 'record-item';
    item.innerHTML = `
      <b>${r.family}</b> · ${r.status} · ${r.duration != null ? `${r.duration}ms` : '-'}
      ${r.transferSize != null ? ` · ${(r.transferSize / 1024).toFixed(1)}KB` : ''}
      ${r.error ? ` · <span class="reason">${r.error}</span>` : ''}
      <br>${r.url ? shortUrl(r.url) : '(无生效源)'} · ${new Date(r.timestamp).toLocaleString('zh-CN')}`;
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------- 事件绑定

const EVENTS = [
  'font-registered', 'font-rejected', 'status-change', 'source-skipped',
  'source-failed', 'font-fallback', 'fallback-missing', 'font-used',
  'resource-timing', 'destroyed',
];
for (const type of EVENTS) {
  manager.addEventListener(type, (e) => logEvent(type, e.detail));
}
manager.addEventListener('status-change', () => {
  for (const record of manager.fonts.values()) updateCard(record);
  updateSummary();
});
manager.addEventListener('font-fallback', () => renderFallbackRecords());

document.getElementById('btn-load').addEventListener('click', async (e) => {
  e.target.disabled = true;
  logEvent('ui', { action: 'loadAll' });
  await manager.loadAll();
  renderAllPreviews();
  await renderFallbackRecords();
  await renderHistory();
});

document.getElementById('btn-destroy').addEventListener('click', () => {
  manager.destroy();
  logEvent('ui', { action: 'destroy — 已中断请求、移除 FontFace、断开 PerformanceObserver' });
  document.getElementById('btn-load').disabled = true;
  document.getElementById('btn-destroy').disabled = true;
});

document.getElementById('btn-clear').addEventListener('click', async () => {
  await store.clearAll();
  await renderFallbackRecords();
  await renderHistory();
  logEvent('ui', { action: '清空 IndexedDB 记录' });
});

// 首次进入展示历史记录
renderFallbackRecords();
renderHistory();
