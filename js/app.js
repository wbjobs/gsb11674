/* UI 装配：字体卡片、状态面板、回退记录、预览 */
import { FontManager, STATUS } from './font-manager.js';
import { getFallbackRecords, clearFallbackRecords, closeDB } from './font-db.js';
import { renderPreview } from './preview.js';

/* 演示字体配置：覆盖正常 / 404 / CORS / 格式不支持 / 超时 等链路 */
const FONT_CONFIGS = [
  {
    family: 'Roboto',
    srcs: [{ url: 'https://cdn.jsdelivr.net/fontsource/fonts/roboto@latest/latin-400-normal.woff2' }],
    fallbacks: ['Arial', 'sans-serif'],
    priority: 1,
    sampleText: 'Roboto: The quick brown fox jumps over the lazy dog 0123',
  },
  {
    family: 'Fira Code',
    srcs: [
      { url: 'https://cdn.jsdelivr.net/fontsource/fonts/fira-code@latest/latin-400-normal.woff2' },
      { url: 'https://cdn.jsdelivr.net/fontsource/fonts/fira-code@latest/latin-400-normal.woff' },
    ],
    fallbacks: ['Consolas', 'monospace'],
    priority: 2,
    sampleText: 'Fira Code: const sum = (a, b) => a + b; // => 42',
  },
  {
    family: 'Noto Serif JP',
    srcs: [{ url: 'https://cdn.jsdelivr.net/fontsource/fonts/noto-serif-jp@latest/japanese-400-normal.woff2' }],
    fallbacks: ['Georgia', 'serif'],
    priority: 3,
    sampleText: 'Noto Serif JP: こんにちは世界、フォントのプレビューです。',
  },
  {
    family: 'Ghost Font (404)',
    srcs: [{ url: 'https://cdn.jsdelivr.net/fontsource/fonts/this-font-does-not-exist@latest/latin-400-normal.woff2' }],
    fallbacks: ['Roboto', 'Verdana', 'sans-serif'],
    priority: 4,
    sampleText: '此字体地址 404，应回退到 Roboto / Verdana。',
  },
  {
    family: 'CORS Font',
    srcs: [{ url: 'https://example.com/fonts/protected.woff2' }],
    fallbacks: ['Noto Serif JP', 'serif'],
    priority: 5,
    sampleText: '此地址无 CORS 头，应被拦截并回退到 serif 链。',
  },
  {
    family: 'Legacy Font (EOT)',
    srcs: [{ url: 'https://cdn.jsdelivr.net/fontsource/fonts/roboto@latest/latin-400-normal.eot' }],
    fallbacks: ['Fira Code', 'monospace'],
    priority: 6,
    sampleText: 'EOT 格式不被支持，应直接降级到 Fira Code。',
  },
  {
    family: 'Slow Font',
    srcs: [{ url: 'https://httpbin.org/delay/15' }],
    fallbacks: ['Missing Fallback Font', 'Roboto', 'sans-serif'],
    priority: 7,
    timeout: 3000,
    sampleText: '3 秒超时中断；首个回退缺失，应继续向下回退。',
  },
];

const STATUS_LABEL = {
  [STATUS.PENDING]: '待加载',
  [STATUS.QUEUED]: '排队中',
  [STATUS.LOADING]: '加载中',
  [STATUS.LOADED]: '已加载',
  [STATUS.FAILED]: '失败',
  [STATUS.TIMEOUT]: '超时中断',
  [STATUS.CORS_BLOCKED]: 'CORS 拦截',
  [STATUS.UNSUPPORTED]: '格式不支持',
  [STATUS.FALLBACK]: '已回退',
};

const manager = new FontManager({ maxConcurrent: 3, maxFonts: 20, defaultTimeout: 8000 });
const cardsEl = document.getElementById('font-cards');
const summaryEl = document.getElementById('summary');
const overflowEl = document.getElementById('overflow-notice');
const cardMap = new Map();

function fmtMs(v) {
  return v === null || v === undefined ? '—' : v.toFixed(1) + ' ms';
}

function buildCards() {
  for (const cfg of FONT_CONFIGS) {
    const record = manager.register(cfg);
    if (!record) {
      overflowEl.textContent = `字体数量超过上限（${manager.maxFonts}），"${cfg.family}" 已被拒绝注册。`;
      overflowEl.hidden = false;
      continue;
    }
    const card = document.createElement('section');
    card.className = 'card';
    card.dataset.fontFamily = record.family;
    card.innerHTML = `
      <header>
        <h3>${record.family}</h3>
        <span class="badge" data-role="badge">${STATUS_LABEL[record.status]}</span>
      </header>
      <canvas class="preview" data-role="preview"></canvas>
      <dl class="meta">
        <div><dt>加载耗时</dt><dd data-role="duration">—</dd></div>
        <div><dt>网络耗时</dt><dd data-role="res-duration">—</dd></div>
        <div><dt>格式</dt><dd data-role="format">—</dd></div>
        <div><dt>使用元素</dt><dd data-role="usage">0</dd></div>
        <div><dt>生效字体栈</dt><dd data-role="stack" class="stack">—</dd></div>
        <div><dt>回退信息</dt><dd data-role="fallback">—</dd></div>
      </dl>`;
    cardsEl.appendChild(card);
    cardMap.set(record.family, card);
    drawPreview(record);
  }
}

function drawPreview(record) {
  const card = cardMap.get(record.family);
  if (!card) return;
  const canvas = card.querySelector('[data-role="preview"]');
  const stack = manager.getFontStack(record.family);
  let badge = null;
  let badgeColor = '#64748b';
  if (record.status === STATUS.LOADED) { badge = 'Web Font'; badgeColor = '#15803d'; }
  else if (record.status === STATUS.FALLBACK) { badge = '回退字体'; badgeColor = '#b45309'; }
  else if (record.status === STATUS.LOADING || record.status === STATUS.QUEUED) { badge = '加载中…'; badgeColor = '#1d4ed8'; }
  renderPreview(canvas, record.sampleText, stack, { badge, badgeColor });
}

function updateCard(record) {
  const card = cardMap.get(record.family);
  if (!card) return;
  const badge = card.querySelector('[data-role="badge"]');
  badge.textContent = STATUS_LABEL[record.status] || record.status;
  badge.dataset.status = record.status;
  card.querySelector('[data-role="duration"]').textContent = fmtMs(record.duration);
  card.querySelector('[data-role="res-duration"]').textContent = fmtMs(record.resourceDuration);
  card.querySelector('[data-role="format"]').textContent = record.activeFormat || '—';
  card.querySelector('[data-role="usage"]').textContent = String(manager.countUsage(record.family));
  card.querySelector('[data-role="stack"]').textContent = manager.getFontStack(record.family);
  const fallbackEl = card.querySelector('[data-role="fallback"]');
  fallbackEl.textContent = record.status === STATUS.FALLBACK
    ? `→ ${record.fallbackTo}（${record.fallbackReason}）`
    : '—';
  drawPreview(record);
}

function updateSummary() {
  const records = [...manager.fonts.values()];
  const loaded = records.filter((r) => r.status === STATUS.LOADED).length;
  const fallback = records.filter((r) => r.status === STATUS.FALLBACK).length;
  const loading = records.filter((r) => r.status === STATUS.LOADING || r.status === STATUS.QUEUED).length;
  summaryEl.textContent = `共 ${records.length} 个字体 · 成功 ${loaded} · 回退 ${fallback} · 进行中 ${loading} · 并发上限 ${manager.maxConcurrent}`;
}

async function refreshFallbackTable() {
  const tbody = document.querySelector('#fallback-table tbody');
  tbody.innerHTML = '';
  let records = [];
  try {
    records = await getFallbackRecords();
  } catch (_) { /* IndexedDB 不可用时静默 */ }
  if (records.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无回退记录</td></tr>';
    return;
  }
  for (const r of records.sort((a, b) => b.time - a.time)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(r.time).toLocaleTimeString()}</td>
      <td>${r.family}</td>
      <td>${r.from} → ${r.to}</td>
      <td>${r.status}</td>
      <td>${r.reason}</td>`;
    tbody.appendChild(tr);
  }
}

manager.on((type, payload) => {
  if (type === 'status') {
    updateCard(payload);
    updateSummary();
  } else if (type === 'fallback') {
    refreshFallbackTable();
  } else if (type === 'overflow') {
    overflowEl.textContent = `字体数量超过上限（${payload.max}），"${payload.family}" 已被拒绝注册。`;
    overflowEl.hidden = false;
  } else if (type === 'cleanup') {
    closeDB();
  }
});

document.getElementById('reload-btn').addEventListener('click', () => {
  manager.cleanup();
  location.reload();
});

document.getElementById('clear-records-btn').addEventListener('click', async () => {
  await clearFallbackRecords().catch(() => {});
  refreshFallbackTable();
});

buildCards();
updateSummary();
refreshFallbackTable();
manager.loadAll();
