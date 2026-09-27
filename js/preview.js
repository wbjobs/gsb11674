/**
 * 字体预览：Canvas 渲染样本文字。
 * 通过对比渲染宽度可粗略判断字体是否真正生效（而非静默）。
 */

/** 在 canvas 上绘制样本文字。返回实际使用的 font 栈。 */
export function renderPreview(canvas, text, fontStack, options = {}) {
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = options.width || canvas.clientWidth || 560;
  const cssHeight = options.height || 72;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const fontSize = options.fontSize || 28;
  ctx.font = `${fontSize}px ${fontStack}`;
  ctx.fillStyle = options.color || '#e8eaf0';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 12, cssHeight / 2, cssWidth - 24);
  return fontStack;
}

/** 测量文本在指定字体栈下的宽度（用于判断字体是否真正命中）。 */
export function measureTextWidth(text, fontStack, fontSize = 28) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px ${fontStack}`;
  return ctx.measureText(text).width;
}

/**
 * 粗略检测字体是否真正生效：
 * 与纯 generic 族渲染宽度对比，若一致则大概率未命中 Web Font。
 */
export function isFontLikelyApplied(text, family) {
  const target = measureTextWidth(text, `"${family}", monospace`);
  const generic = measureTextWidth(text, 'monospace');
  return Math.abs(target - generic) > 0.5;
}
