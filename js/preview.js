/* Canvas 字体预览 */
export function renderPreview(canvas, text, fontStack, options = {}) {
  const dpr = window.devicePixelRatio || 1;
  const width = options.width || canvas.clientWidth || 320;
  const height = options.height || 64;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.height = height + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const fontSize = options.fontSize || 22;
  ctx.font = `${fontSize}px ${fontStack}`;
  ctx.fillStyle = options.color || '#1f2933';
  ctx.textBaseline = 'middle';

  // 超长文本省略
  let display = text;
  const maxWidth = width - 16;
  if (ctx.measureText(display).width > maxWidth) {
    while (display.length > 1 && ctx.measureText(display + '…').width > maxWidth) {
      display = display.slice(0, -1);
    }
    display += '…';
  }
  ctx.fillText(display, 8, height / 2);

  // 角标：实际渲染是否命中目标字体
  if (options.badge) {
    ctx.font = '11px sans-serif';
    const badgeWidth = ctx.measureText(options.badge).width + 12;
    ctx.fillStyle = options.badgeColor || '#64748b';
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath();
      ctx.roundRect(width - badgeWidth - 6, 6, badgeWidth, 18, 4);
      ctx.fill();
    } else {
      ctx.fillRect(width - badgeWidth - 6, 6, badgeWidth, 18);
    }
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(options.badge, width - badgeWidth, 15);
  }
}
