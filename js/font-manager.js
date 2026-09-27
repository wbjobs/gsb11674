/* 核心字体加载管理器
 * - FontFace API + fetch(ArrayBuffer) 实现可中断加载
 * - 并发限制 + 优先级队列保证加载顺序
 * - 超时中断 / CORS 检测 / 格式探测 / 降级链回退
 * - PerformanceObserver 采集资源耗时
 * - 页面卸载时统一清理
 */
import { addFallbackRecord, addLoadStat } from './font-db.js';

export const STATUS = {
  PENDING: 'pending',
  QUEUED: 'queued',
  LOADING: 'loading',
  LOADED: 'loaded',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
  CORS_BLOCKED: 'cors-blocked',
  UNSUPPORTED: 'unsupported',
  FALLBACK: 'fallback',
};

const FORMAT_BY_EXT = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
  eot: 'embedded-opentype',
  svg: 'svg',
};

/* 静态能力表：现代浏览器均支持 woff2/woff/ttf/otf；eot/svg 视为不支持 */
const FORMAT_SUPPORT = {
  woff2: true,
  woff: true,
  ttf: true,
  otf: true,
  eot: false,
  svg: false,
};

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
  'emoji', 'math', 'fangsong',
]);

function extOf(url) {
  const clean = url.split(/[?#]/)[0];
  const m = /\.([a-z0-9]+)$/i.exec(clean);
  return m ? m[1].toLowerCase() : '';
}

export function isFormatSupported(url) {
  const ext = extOf(url);
  const fmt = FORMAT_BY_EXT[ext];
  if (!fmt) return false;
  return FORMAT_SUPPORT[ext] === true;
}

function isGenericFamily(name) {
  return GENERIC_FAMILIES.has(String(name).trim().toLowerCase());
}

export class FontManager {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 3;
    this.maxFonts = options.maxFonts || 20;
    this.defaultTimeout = options.defaultTimeout || 8000;
    this.fonts = new Map();       // family -> record
    this.queue = [];              // 待加载 family（按 priority 排序）
    this.running = 0;
    this.listeners = new Set();
    this.addedFaces = new Set();  // 已加入 document.fonts 的 FontFace
    this.observer = null;
    this.resourceTimings = new Map(); // url -> duration
    this.destroyed = false;
    this._onPageHide = this.cleanup.bind(this);
    window.addEventListener('pagehide', this._onPageHide);
    window.addEventListener('beforeunload', this._onPageHide);
    this._initPerformanceObserver();
  }

  _initPerformanceObserver() {
    if (!('PerformanceObserver' in window)) return;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.initiatorType === 'font' || entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest') {
            this.resourceTimings.set(entry.name, entry.duration);
            this._emit('resource', { url: entry.name, duration: entry.duration });
          }
        }
      });
      this.observer.observe({ type: 'resource', buffered: true });
    } catch (_) {
      this.observer = null;
    }
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(type, payload) {
    for (const fn of this.listeners) {
      try { fn(type, payload); } catch (_) { /* 监听器异常不影响主流程 */ }
    }
  }

  /* 注册字体。config: { family, srcs: [{url, format?}], fallbacks: [], timeout?, priority?, sampleText? } */
  register(config) {
    if (this.fonts.size >= this.maxFonts) {
      this._emit('overflow', { family: config.family, max: this.maxFonts });
      return null;
    }
    const record = {
      family: config.family,
      srcs: config.srcs || [],
      fallbacks: config.fallbacks || ['sans-serif'],
      timeout: config.timeout || this.defaultTimeout,
      priority: config.priority || 0,
      sampleText: config.sampleText || 'The quick brown fox jumps over the lazy dog 字体预览 0123456789',
      status: STATUS.PENDING,
      error: null,
      activeUrl: null,
      activeFormat: null,
      duration: null,          // 加载耗时 ms
      resourceDuration: null,  // PerformanceObserver 网络耗时 ms
      appliedStack: null,      // 最终生效的 font-family 栈
      fallbackTo: null,        // 实际回退到的字体
      fallbackReason: null,
      usedBy: [],              // 使用该字体的元素计数
      controller: null,
    };
    this.fonts.set(record.family, record);
    return record;
  }

  /* 按优先级入队并启动加载 */
  loadAll() {
    const records = [...this.fonts.values()].sort((a, b) => a.priority - b.priority);
    this.queue = records.map((r) => r.family);
    for (const r of records) this._setStatus(r, STATUS.QUEUED);
    this._pump();
    return Promise.allSettled(records.map((r) => r.promise || Promise.resolve()));
  }

  _pump() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const family = this.queue.shift();
      const record = this.fonts.get(family);
      if (!record || record.status !== STATUS.QUEUED) continue;
      this.running++;
      record.promise = this._loadOne(record)
        .catch(() => {})
        .finally(() => {
          this.running--;
          this._pump();
        });
    }
  }

  _setStatus(record, status, extra = {}) {
    record.status = status;
    Object.assign(record, extra);
    this._emit('status', record);
  }

  /* 选择第一个受支持的源；全部不支持则走降级 */
  _pickSource(record) {
    for (const src of record.srcs) {
      if (isFormatSupported(src.url)) return src;
    }
    return null;
  }

  async _loadOne(record) {
    const src = this._pickSource(record);
    if (!src) {
      await this._fail(record, STATUS.UNSUPPORTED, '所有字体格式均不受支持');
      return;
    }
    record.activeUrl = src.url;
    record.activeFormat = extOf(src.url);
    this._setStatus(record, STATUS.LOADING);

    const controller = new AbortController();
    record.controller = controller;
    const startedAt = performance.now();
    const timer = setTimeout(() => controller.abort(), record.timeout);

    try {
      // fetch 显式走 CORS；失败可区分 CORS / 网络 / 超时
      const resp = await fetch(src.url, { mode: 'cors', signal: controller.signal, credentials: 'omit' });
      if (!resp.ok) throw Object.assign(new Error('HTTP ' + resp.status), { code: 'HTTP_' + resp.status });
      const buffer = await resp.arrayBuffer();
      const face = new FontFace(record.family, buffer);
      await face.load();
      if (this.destroyed) return;
      document.fonts.add(face);
      this.addedFaces.add(face);
      const duration = performance.now() - startedAt;
      const resDuration = this.resourceTimings.get(src.url);
      this._setStatus(record, STATUS.LOADED, {
        duration,
        resourceDuration: resDuration !== undefined ? resDuration : null,
        appliedStack: `"${record.family}", ${record.fallbacks.join(', ')}`,
      });
      addLoadStat({
        family: record.family, url: src.url, format: record.activeFormat,
        duration, resourceDuration: record.resourceDuration, status: STATUS.LOADED, time: Date.now(),
      }).catch(() => {});
    } catch (err) {
      if (this.destroyed) return;
      let status = STATUS.FAILED;
      let reason = (err && err.message) || '未知错误';
      if (err && err.name === 'AbortError') {
        status = STATUS.TIMEOUT;
        reason = `加载超过 ${record.timeout}ms，已中断`;
      } else if (err instanceof TypeError) {
        // fetch 的 TypeError 多为 CORS 被拦截或网络不可达
        status = STATUS.CORS_BLOCKED;
        reason = '跨域受限或网络不可达（CORS / network）';
      }
      await this._fail(record, status, reason, performance.now() - startedAt);
    } finally {
      clearTimeout(timer);
      record.controller = null;
    }
  }

  /* 失败处理：沿降级链回退并记录 */
  async _fail(record, status, reason, duration) {
    const chain = [record.family, ...record.fallbacks];
    let applied = null;
    let fallbackTo = null;
    for (let i = 1; i < chain.length; i++) {
      const candidate = chain[i];
      if (isGenericFamily(candidate)) { applied = candidate; fallbackTo = candidate; break; }
      const fallbackRecord = this.fonts.get(candidate);
      if (fallbackRecord && fallbackRecord.status === STATUS.LOADED) {
        applied = candidate; fallbackTo = candidate; break;
      }
      if (!fallbackRecord && document.fonts.check(`12px "${candidate}"`)) {
        applied = candidate; fallbackTo = candidate; break;
      }
      // 回退字体缺失：记录并继续向下找
      addFallbackRecord({
        family: record.family, from: chain[i - 1], to: candidate,
        reason: '回退字体缺失，继续向下回退', status: 'fallback-missing', time: Date.now(),
      }).catch(() => {});
    }
    if (!applied) {
      applied = 'sans-serif';
      fallbackTo = 'sans-serif';
      addFallbackRecord({
        family: record.family, from: record.family, to: 'sans-serif',
        reason: '降级链全部缺失，兜底为 sans-serif', status: 'fallback-exhausted', time: Date.now(),
      }).catch(() => {});
    }
    addFallbackRecord({
      family: record.family, from: record.family, to: fallbackTo,
      reason, status, time: Date.now(),
    }).catch(() => {});
    addLoadStat({
      family: record.family, url: record.activeUrl, format: record.activeFormat,
      duration: duration || null, status, time: Date.now(),
    }).catch(() => {});
    this._setStatus(record, STATUS.FALLBACK, {
      error: reason,
      duration: duration || null,
      fallbackTo,
      fallbackReason: reason,
      appliedStack: chain.includes(fallbackTo)
        ? chain.slice(chain.indexOf(fallbackTo)).join(', ')
        : fallbackTo,
    });
    this._emit('fallback', record);
  }

  /* 供 UI 查询最终生效的 font-family 栈 */
  getFontStack(family) {
    const record = this.fonts.get(family);
    if (!record) return 'sans-serif';
    if (record.status === STATUS.LOADED) return `"${family}", ${record.fallbacks.join(', ')}`;
    if (record.status === STATUS.FALLBACK) return record.appliedStack || 'sans-serif';
    return record.fallbacks.join(', ') || 'sans-serif';
  }

  /* 统计某字体被多少已挂载元素使用 */
  countUsage(family) {
    let count = 0;
    document.querySelectorAll('[data-font-family]').forEach((el) => {
      if (el.dataset.fontFamily === family) count++;
    });
    return count;
  }

  /* 页面卸载 / 手动销毁：中断请求、移除 FontFace、断开观察者 */
  cleanup() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const record of this.fonts.values()) {
      if (record.controller) {
        try { record.controller.abort(); } catch (_) {}
      }
    }
    for (const face of this.addedFaces) {
      try { document.fonts.delete(face); } catch (_) {}
    }
    this.addedFaces.clear();
    if (this.observer) {
      try { this.observer.disconnect(); } catch (_) {}
      this.observer = null;
    }
    window.removeEventListener('pagehide', this._onPageHide);
    window.removeEventListener('beforeunload', this._onPageHide);
    this._emit('cleanup', {});
  }
}
