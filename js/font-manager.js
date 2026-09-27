/**
 * FontManager — 多 Web Font 加载管理器（原生 FontFace / Font Loading API）
 *
 * 能力：
 *  - 多字体注册与按优先级顺序加载（并发数可控、总数可控）
 *  - 超时中断（AbortController + 竞速）
 *  - CORS / 404 / 网络错误分类处理
 *  - 字体格式不支持时在同字体的 sources 内降级
 *  - 整字失败时按 fallback 链回退，并记录回退事件
 *  - PerformanceObserver 采集资源计时
 *  - pagehide 时自动清理（中断请求、移除 FontFace、断开观察者）
 */

export const FontStatus = Object.freeze({
  PENDING: 'pending',
  LOADING: 'loading',
  LOADED: 'loaded',
  ERROR: 'error',
  TIMEOUT: 'timeout',
  FORMAT_UNSUPPORTED: 'format-unsupported',
  FALLBACK: 'fallback',
  UNLOADED: 'unloaded',
});

const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy',
  'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded',
  'emoji', 'math', 'fangsong',
]);

const FONT_RESOURCE_TYPES = /font|woff|truetype|opentype/i;

function isFormatSupported(format) {
  if (!('FontFace' in window)) return false;
  switch ((format || '').toLowerCase()) {
    case 'woff2':
    case 'woff':
    case 'truetype':
    case 'opentype':
    case 'ttf':
    case 'otf':
      return true;
    // EOT 仅旧 IE 支持，SVG 字体已被废弃 —— 现代浏览器一律视为不支持
    case 'eot':
    case 'embedded-opentype':
    case 'svg':
      return false;
    default:
      return false;
  }
}

function classifyFetchError(err, response) {
  if (err && err.name === 'AbortError') return 'aborted';
  if (err && err.name === 'TimeoutError') return 'timeout';
  if (response) {
    if (response.status === 404) return 'not-found';
    return `http-${response.status}`;
  }
  // fetch 在 CORS 拦截与网络故障时都抛 TypeError，无法进一步区分
  if (err instanceof TypeError) return 'cors-or-network';
  return 'unknown';
}

export class FontManager extends EventTarget {
  /**
   * @param {object} options
   * @param {number} options.maxFonts       允许注册的最大字体数（超出拒绝注册）
   * @param {number} options.maxConcurrent  最大并发加载数
   * @param {number} options.defaultTimeout 默认单源超时（ms）
   * @param {FontStore|null} options.store  IndexedDB 记录存储（可选）
   */
  constructor(options = {}) {
    super();
    this.maxFonts = options.maxFonts ?? 20;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this.defaultTimeout = options.defaultTimeout ?? 5000;
    this.store = options.store ?? null;

    /** @type {Map<string, object>} family -> record */
    this.fonts = new Map();
    this.usage = new Map(); // family -> count
    this.fallbackRecords = [];
    this._queue = [];
    this._activeCount = 0;
    this._destroyed = false;
    this._abortControllers = new Set();
    this._resourceTimings = new Map(); // url -> PerformanceResourceTiming
    this._loadPromises = new Map();    // family -> Promise<record>（用于回退链等待其它 Web Font）
    this._fallbackResolving = new Set(); // 正在解析回退链的 family（防止循环等待死锁）

    this._observer = null;
    this._initPerformanceObserver();

    this._onPageHide = () => this.destroy();
    window.addEventListener('pagehide', this._onPageHide);
  }

  // ---------------------------------------------------------------- 注册

  /**
   * 注册字体。
   * config: {
   *   family, descriptors?,
   *   sources: [{ url, format, timeout? }],   // 按优先级排列，格式不支持/加载失败自动降级到下一个
   *   fallbacks: ['OtherWebFont', 'Georgia', 'serif'],  // 整字失败时的回退链
   *   priority?: number,   // 数值小先加载，默认 100
   *   timeout?: number,    // 覆盖默认超时
   *   sampleText?: string,
   * }
   */
  register(config) {
    if (this._destroyed) throw new Error('FontManager 已销毁');
    if (!config || !config.family) throw new Error('register: 缺少 family');
    if (this.fonts.has(config.family)) throw new Error(`字体重复注册: ${config.family}`);
    if (this.fonts.size >= this.maxFonts) {
      const err = new Error(`字体数量超限（max ${this.maxFonts}），拒绝注册: ${config.family}`);
      this._emit('font-rejected', { family: config.family, reason: 'too-many-fonts' });
      throw err;
    }
    if (!Array.isArray(config.sources) || config.sources.length === 0) {
      throw new Error(`register(${config.family}): 至少需要一个 source`);
    }

    const record = {
      family: config.family,
      descriptors: config.descriptors || {},
      sources: config.sources.slice(),
      fallbacks: (config.fallbacks || ['sans-serif']).slice(),
      priority: config.priority ?? 100,
      timeout: config.timeout ?? this.defaultTimeout,
      sampleText: config.sampleText || 'The quick brown fox jumps over the lazy dog 0123456789',
      status: FontStatus.PENDING,
      activeSource: null,   // 实际生效的 source
      fontFace: null,
      duration: null,       // 加载耗时 ms
      error: null,
      attempts: [],         // 每个 source 的尝试记录
      effectiveStack: null, // 最终生效的 font-family 栈
    };
    this.fonts.set(record.family, record);
    this._emit('font-registered', { family: record.family });
    return record;
  }

  // ---------------------------------------------------------------- 加载

  /** 按优先级加载全部已注册字体（并发受限）。 */
  loadAll() {
    const records = [...this.fonts.values()]
      .filter(r => r.status === FontStatus.PENDING)
      .sort((a, b) => a.priority - b.priority);
    return Promise.all(records.map(r => this._enqueue(r)));
  }

  load(family) {
    const record = this.fonts.get(family);
    if (!record) return Promise.reject(new Error(`未注册的字体: ${family}`));
    if (record.status !== FontStatus.PENDING) return Promise.resolve(record);
    return this._enqueue(record);
  }

  _enqueue(record) {
    const promise = new Promise((resolve) => {
      this._queue.push({ record, resolve });
      this._pump();
    });
    this._loadPromises.set(record.family, promise);
    return promise;
  }

  _pump() {
    while (this._activeCount < this.maxConcurrent && this._queue.length > 0) {
      const { record, resolve } = this._queue.shift();
      this._activeCount++;
      this._runRecord(record, resolve);
    }
  }

  _runRecord(record, resolve) {
    this._loadRecord(record)
      .catch(() => {}) // 失败已在 _loadRecord 内处理为回退
      .finally(() => {
        this._activeCount--;
        resolve(record);
        this._pump();
      });
  }

  /** 回退链依赖的字体还在排队时，将其提前立即加载（避免并发槽占满造成死锁）。 */
  _prioritize(family) {
    const idx = this._queue.findIndex(q => q.record.family === family);
    if (idx === -1) return;
    const [{ record, resolve }] = this._queue.splice(idx, 1);
    this._activeCount++;
    this._runRecord(record, resolve);
  }

  async _loadRecord(record) {
    this._setStatus(record, FontStatus.LOADING);
    const startedAt = performance.now();

    // 1) 过滤掉浏览器不支持的格式
    const usable = [];
    for (const source of record.sources) {
      if (isFormatSupported(source.format)) {
        usable.push(source);
      } else {
        record.attempts.push({ url: source.url, format: source.format, ok: false, reason: 'format-unsupported' });
        this._emit('source-skipped', { family: record.family, url: source.url, reason: 'format-unsupported' });
      }
    }

    // 2) 依次尝试可用 source
    for (const source of usable) {
      const attempt = await this._trySource(record, source);
      record.attempts.push(attempt);
      if (attempt.ok) {
        record.duration = Math.round((performance.now() - startedAt) * 10) / 10;
        record.activeSource = source;
        record.effectiveStack = this._buildStack(record.family, record.fallbacks);
        this._setStatus(record, FontStatus.LOADED);
        this._persist('loads', this._loadLog(record, 'loaded'));
        return record;
      }
    }

    // 3) 全部失败 —— 进入回退链
    record.duration = Math.round((performance.now() - startedAt) * 10) / 10;
    const lastReason = record.attempts.length
      ? record.attempts[record.attempts.length - 1].reason
      : 'format-unsupported';
    const isTimeout = record.attempts.some(a => a.reason === 'timeout');
    this._setStatus(record, isTimeout ? FontStatus.TIMEOUT : FontStatus.ERROR, lastReason);
    await this._applyFallback(record, lastReason);
    this._persist('loads', this._loadLog(record, record.status));
    return record;
  }

  async _trySource(record, source) {
    const timeout = source.timeout ?? record.timeout;
    const controller = new AbortController();
    this._abortControllers.add(controller);
    const timer = setTimeout(() => controller.abort(new DOMException('字体加载超时', 'TimeoutError')), timeout);
    const startedAt = performance.now();
    let response = null;
    try {
      response = await fetch(source.url, {
        signal: controller.signal,
        mode: 'cors',          // 显式 CORS；被拦截时抛 TypeError
        credentials: 'omit',
        cache: 'default',
      });
      if (!response.ok) {
        return { url: source.url, format: source.format, ok: false, reason: classifyFetchError(null, response), duration: this._elapsed(startedAt) };
      }
      if (controller.signal.aborted) throw controller.signal.reason || new DOMException('Aborted', 'AbortError');
      const buffer = await response.arrayBuffer();
      if (controller.signal.aborted) throw controller.signal.reason || new DOMException('Aborted', 'AbortError');
      const fontFace = new FontFace(record.family, buffer, record.descriptors);
      // load() 同样受超时约束（解码阶段也可能挂起）
      await Promise.race([
        fontFace.load(),
        new Promise((_, reject) => {
          if (controller.signal.aborted) {
            reject(controller.signal.reason || new DOMException('Aborted', 'AbortError'));
            return;
          }
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason || new DOMException('Aborted', 'AbortError')), { once: true });
        }),
      ]);
      document.fonts.add(fontFace);
      record.fontFace = fontFace;
      return { url: source.url, format: source.format, ok: true, reason: null, duration: this._elapsed(startedAt) };
    } catch (err) {
      const reason = classifyFetchError(err, null);
      this._emit('source-failed', { family: record.family, url: source.url, reason });
      return { url: source.url, format: source.format, ok: false, reason, duration: this._elapsed(startedAt) };
    } finally {
      clearTimeout(timer);
      this._abortControllers.delete(controller);
    }
  }

  _elapsed(startedAt) {
    return Math.round((performance.now() - startedAt) * 10) / 10;
  }

  // ---------------------------------------------------------------- 回退

  async _applyFallback(record, reason) {
    this._fallbackResolving.add(record.family);
    const usable = [];
    const missing = [];
    for (const fb of record.fallbacks) {
      if (GENERIC_FAMILIES.has(fb)) {
        usable.push(fb); // 通用族永远可用
        continue;
      }
      const target = this.fonts.get(fb);
      if (target) {
        // 回退目标是另一个 Web Font：若仍在加载则等它结束（循环依赖时跳过等待）
        if (target.status !== FontStatus.LOADED && !this._fallbackResolving.has(fb)) {
          if (target.status === FontStatus.PENDING) this._prioritize(fb);
          const pending = this._loadPromises.get(fb);
          if (pending) await pending.catch(() => {});
        }
        if (target.status === FontStatus.LOADED) {
          usable.push(fb);
        } else {
          missing.push(fb); // 回退的 Web Font 自身也加载失败
        }
        continue;
      }
      if (document.fonts.check(`12px "${fb}"`)) {
        usable.push(fb); // 本机已安装的字体
      } else {
        missing.push(fb); // 回退字体缺失
      }
    }
    this._fallbackResolving.delete(record.family);

    record.effectiveStack = this._buildStack(null, usable.length ? usable : ['sans-serif']);
    this._setStatus(record, FontStatus.FALLBACK);

    const fallbackRecord = {
      family: record.family,
      reason,
      requested: record.fallbacks.slice(),
      resolved: usable.slice(),
      missing,
      effectiveStack: record.effectiveStack,
      timestamp: Date.now(),
    };
    this.fallbackRecords.push(fallbackRecord);
    this._persist('fallbacks', fallbackRecord);
    this._emit('font-fallback', fallbackRecord);

    if (missing.length) {
      this._emit('fallback-missing', { family: record.family, missing });
    }
  }

  _buildStack(primary, fallbacks) {
    const parts = [];
    if (primary) parts.push(`"${primary}"`);
    for (const fb of fallbacks) {
      parts.push(GENERIC_FAMILIES.has(fb) ? fb : `"${fb}"`);
    }
    return parts.join(', ');
  }

  // ---------------------------------------------------------------- 使用统计

  /** 把字体（含回退栈）应用到元素，并统计使用次数。 */
  applyTo(element, family) {
    const record = this.fonts.get(family);
    const stack = record && record.effectiveStack
      ? record.effectiveStack
      : this._buildStack(family, ['sans-serif']);
    element.style.fontFamily = stack;
    const count = (this.usage.get(family) || 0) + 1;
    this.usage.set(family, count);
    this._persist('usage', { family, count, timestamp: Date.now() });
    this._emit('font-used', { family, count });
    return stack;
  }

  getUsage(family) {
    return this.usage.get(family) || 0;
  }

  // ---------------------------------------------------------------- 状态 / 清理

  _setStatus(record, status, error = null) {
    record.status = status;
    record.error = error;
    this._emit('status-change', { family: record.family, status, error });
  }

  _loadLog(record, status) {
    const timing = record.activeSource ? this._resourceTimings.get(record.activeSource.url) : null;
    return {
      family: record.family,
      status,
      url: record.activeSource ? record.activeSource.url : null,
      duration: record.duration,
      transferSize: timing ? timing.transferSize : null,
      error: record.error,
      attempts: record.attempts,
      timestamp: Date.now(),
    };
  }

  _initPerformanceObserver() {
    if (!('PerformanceObserver' in window)) return;
    try {
      this._observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.initiatorType === 'font' || FONT_RESOURCE_TYPES.test(entry.name)) {
            this._resourceTimings.set(entry.name, entry);
            this._emit('resource-timing', {
              url: entry.name,
              duration: Math.round(entry.duration * 10) / 10,
              transferSize: entry.transferSize,
            });
          }
        }
      });
      this._observer.observe({ type: 'resource', buffered: true });
    } catch (_) {
      this._observer = null; // 某些浏览器不支持 type:'resource'
    }
  }

  _persist(storeName, data) {
    if (!this.store) return;
    this.store.add(storeName, data).catch(() => {});
  }

  /** 清理：中断进行中的请求、移除 FontFace、断开观察者。幂等。 */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    window.removeEventListener('pagehide', this._onPageHide);

    for (const controller of this._abortControllers) {
      controller.abort(new DOMException('页面卸载，中断加载', 'AbortError'));
    }
    this._abortControllers.clear();
    // 释放仍在排队的任务，避免等待方悬挂
    for (const { record, resolve } of this._queue.splice(0)) {
      this._setStatus(record, FontStatus.UNLOADED, 'destroyed');
      resolve(record);
    }

    for (const record of this.fonts.values()) {
      if (record.fontFace) {
        try { document.fonts.delete(record.fontFace); } catch (_) {}
        record.fontFace = null;
      }
      if (record.status === FontStatus.LOADING) {
        this._setStatus(record, FontStatus.UNLOADED, 'destroyed');
      }
    }

    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    if (this.store) this.store.close();
    this._emit('destroyed', {});
  }

  // ---------------------------------------------------------------- 事件

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
