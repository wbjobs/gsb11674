# Web Font 加载管理器

纯原生实现（无框架）：FontFace API、Font Loading API、PerformanceObserver、IndexedDB、DOM、Canvas。

## 运行

```bash
python3 -m http.server 8080
# 打开 http://localhost:8080
```

点击「开始加载全部字体」即可观察 7 个演示字体的加载过程，覆盖各类异常链路。

## 文件结构

- `index.html` — 演示页面（状态面板 / 回退记录 / 历史记录 / 事件日志）
- `js/font-manager.js` — 核心 FontManager（注册、加载、超时、回退、清理）
- `js/font-store.js` — IndexedDB 持久化（loads / fallbacks / usage 三个表）
- `js/preview.js` — Canvas 字体预览与命中检测
- `js/main.js` — 演示配置与 UI 接线
- `test/font-manager.smoke.mjs` — Node 冒烟测试（`node test/font-manager.smoke.mjs`）

## 异常链路处理对照

| 场景 | 处理方式 |
| --- | --- |
| 字体加载失败 | 同字体 sources 内依次降级；全部失败进入 fallback 链 |
| 超时 | AbortController 中断 fetch 与 FontFace.load()，标记 `timeout` |
| CORS 限制 | fetch `mode:'cors'`，拦截时归类 `cors-or-network` 并降级 |
| 格式不支持 | 注册时过滤 eot/svg 等不支持格式，直接跳到下一个源 |
| 字体过多 | `maxFonts` 拒绝注册；`maxConcurrent` 限制并发 |
| 加载顺序 | `priority` 小的先加载；回退依赖的字体还在加载时会等待/插队 |
| 页面卸载 | `pagehide` 触发 `destroy()`：中断请求、移除 FontFace、断开 PerformanceObserver、关闭 IndexedDB |
| 回退字体缺失 | 回退链中未注册且本机未安装的字体记入 `missing`，兜底到通用族 |

## API 摘要

```js
const manager = new FontManager({ maxFonts: 20, maxConcurrent: 3, defaultTimeout: 5000, store });
manager.register({
  family: 'Roboto',
  priority: 10,
  sources: [{ url: '.../roboto.woff2', format: 'woff2' }],
  fallbacks: ['Helvetica Neue', 'sans-serif'],
});
await manager.loadAll();
manager.applyTo(el, 'Roboto');   // 应用字体栈并统计使用
manager.destroy();               // 清理（pagehide 自动触发）
```

事件：`status-change` / `source-skipped` / `source-failed` / `font-fallback` / `fallback-missing` / `font-used` / `resource-timing` / `destroyed`。
