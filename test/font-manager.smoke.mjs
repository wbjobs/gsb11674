// Node 环境下对 FontManager 的纯逻辑冒烟测试（mock 浏览器 API）
const listeners = {};
globalThis.window = {
  addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
  removeEventListener: () => {},
  FontFace: class {},
};
globalThis.document = {
  fonts: {
    _set: new Set(),
    add(f) { this._set.add(f); },
    delete(f) { this._set.delete(f); },
    check: (s) => s.includes('Georgia'),
  },
};
globalThis.fetch = (url, opts = {}) => new Promise((resolve, reject) => {
  const signal = opts.signal;
  const fail = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  if (signal) {
    if (signal.aborted) return fail();
    signal.addEventListener('abort', fail, { once: true });
  }
  if (url.includes('404')) return reject(new TypeError('Failed to fetch'));
  const delay = url.includes('slow') ? 200 : 10;
  setTimeout(() => resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }), delay);
});
globalThis.FontFace = class {
  constructor(family, src, desc) { this.family = family; }
  async load() { return this; }
};

const { FontManager, FontStatus } = await import('/home/wangbo/gsbProject/gsb11674/A/js/font-manager.js');

let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); };

// 1. 注册与数量控制
const m = new FontManager({ maxFonts: 2, maxConcurrent: 2, defaultTimeout: 500 });
m.register({ family: 'A', sources: [{ url: 'https://x/a.woff2', format: 'woff2' }] });
m.register({ family: 'B', sources: [{ url: 'https://x/404.woff2', format: 'woff2' }], fallbacks: ['A', 'Georgia', 'serif'] });
try { m.register({ family: 'C', sources: [{ url: 'u', format: 'woff2' }] }); t('maxFonts 拒绝注册', false); }
catch { t('maxFonts 拒绝注册', true); }

// 2. 格式不支持降级：eot 源被跳过，整字回退
const m2 = new FontManager({ defaultTimeout: 500 });
m2.register({ family: 'EotOnly', sources: [{ url: 'https://x/a.eot', format: 'eot' }], fallbacks: ['Georgia', 'serif'] });
await m2.loadAll();
const eot = m2.fonts.get('EotOnly');
t('eot 标记 format-unsupported', eot.attempts[0].reason === 'format-unsupported');
t('eot 整字回退', eot.status === FontStatus.FALLBACK);
t('eot 回退命中 Georgia', eot.effectiveStack.includes('Georgia'));

// 3. 正常加载 + 失败回退 + 回退链等待另一个 Web Font
await m.loadAll();
t('A 加载成功', m.fonts.get('A').status === FontStatus.LOADED);
const b = m.fonts.get('B');
t('B 失败回退', b.status === FontStatus.FALLBACK);
t('B 回退链等待并命中已加载的 A', b.effectiveStack.includes('"A"'));
t('回退记录已生成', m.fallbackRecords.length === 1 && m.fallbackRecords[0].family === 'B');

// 4. 超时中断
const m3 = new FontManager({ defaultTimeout: 30 });
m3.register({ family: 'Slow', sources: [{ url: 'https://x/slow.woff2', format: 'woff2' }], fallbacks: ['NoSuchFont', 'serif'] });
await m3.loadAll();
const slow = m3.fonts.get('Slow');
t('超时中断并回退', slow.status === FontStatus.FALLBACK && slow.attempts[0].reason === 'timeout');
t('回退字体缺失被记录', m3.fallbackRecords[0].missing.includes('NoSuchFont'));
t('缺失时仍回退到 serif', slow.effectiveStack.includes('serif'));

// 5. 加载顺序（priority 小先加载）
const m4 = new FontManager({ maxConcurrent: 1 });
const order = [];
m4.addEventListener('status-change', e => { if (e.detail.status === 'loading') order.push(e.detail.family); });
m4.register({ family: 'Low', priority: 100, sources: [{ url: 'https://x/a.woff2', format: 'woff2' }] });
m4.register({ family: 'High', priority: 1, sources: [{ url: 'https://x/b.woff2', format: 'woff2' }] });
await m4.loadAll();
t('priority 顺序正确', order[0] === 'High' && order[1] === 'Low');

// 6. destroy 清理（幂等、中断、移除 FontFace）
const m5 = new FontManager({ defaultTimeout: 5000 });
m5.register({ family: 'Flying', sources: [{ url: 'https://x/slow.woff2', format: 'woff2' }] });
const p = m5.loadAll();
m5.destroy();
m5.destroy(); // 幂等
await p;
t('destroy 中断进行中的加载', m5.fonts.get('Flying').status !== FontStatus.LOADING);
t('pagehide 已绑定', (listeners['pagehide'] || []).length > 0);

// 6b. destroy 移除已加载的 FontFace
const m6 = new FontManager();
m6.register({ family: 'Cleanup', sources: [{ url: 'https://x/c.woff2', format: 'woff2' }] });
await m6.loadAll();
const face = m6.fonts.get('Cleanup').fontFace;
t('加载后 FontFace 已加入 document.fonts', document.fonts._set.has(face));
m6.destroy();
t('destroy 移除 FontFace', !document.fonts._set.has(face) && m6.fonts.get('Cleanup').fontFace === null);

// 7. applyTo 使用统计
const el = { style: {} };
m.applyTo(el, 'A'); m.applyTo(el, 'A');
t('使用统计计数', m.getUsage('A') === 2);
t('应用字体栈含引号', el.style.fontFamily.includes('"A"'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
