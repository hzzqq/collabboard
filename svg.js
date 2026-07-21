// 白板导出：将 strokes 数组渲染为 SVG（矢量），并提供浏览器端下载工具。
// 同时支持浏览器(<script> 挂到 window)与 Node(require，用于测试)。
(function (root) {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  function ptsStr(points) {
    if (!Array.isArray(points) || !points.length) return '';
    return points.map(p => (p.x != null ? p.x : 0) + ',' + (p.y != null ? p.y : 0)).join(' ');
  }
  // strokes: 客户端 strokes 数组（与 server.js 落盘结构一致）
  // w,h:     画布逻辑尺寸（CSS 像素，不含 dpr）
  function strokesToSVG(strokes, w, h) {
    w = w || 1280; h = h || 720;
    const L = [];
    L.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);
    L.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>`);
    const arr = Array.isArray(strokes) ? strokes : [];
    for (const s of arr) {
      if (!s) continue;
      if (s.type === 'image') {
        L.push(`<image href="${esc(s.src)}" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}"/>`);
        continue;
      }
      if (s.type === 'text') {
        const fs = Math.max(10, s.width || 16);
        L.push(`<text x="${s.x}" y="${s.y + fs}" fill="${esc(s.color || '#000')}" font-family="ui-monospace, monospace" font-size="${fs}">${esc(s.text)}</text>`);
        continue;
      }
      const sw = s.width || 2;
      const col = s.color || '#000';
      // 橡皮擦在 SVG 无透明背景可擦除，渲染为浅灰提示笔迹（不破坏结构）
      const strokeCol = s.erase ? '#cccccc' : col;
      if (s.tool === 'pen' || s.tool === 'eraser') {
        if (!s.points || s.points.length < 1) continue;
        L.push(`<polyline points="${ptsStr(s.points)}" fill="none" stroke="${esc(strokeCol)}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`);
      } else if (s.tool === 'line') {
        const p = s.points || [];
        if (p.length < 2) continue;
        L.push(`<line x1="${p[0].x}" y1="${p[0].y}" x2="${p[1].x}" y2="${p[1].y}" stroke="${esc(strokeCol)}" stroke-width="${sw}" stroke-linecap="round"/>`);
      } else if (s.tool === 'rect') {
        const p = s.points || [];
        if (p.length < 2) continue;
        const x = Math.min(p[0].x, p[1].x), y = Math.min(p[0].y, p[1].y);
        const rw = Math.abs(p[1].x - p[0].x), rh = Math.abs(p[1].y - p[0].y);
        if (s.fill) L.push(`<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="${esc(col)}"/>`);
        else L.push(`<rect x="${x}" y="${y}" width="${rw}" height="${rh}" fill="none" stroke="${esc(col)}" stroke-width="${sw}"/>`);
      } else if (s.tool === 'ellipse') {
        const p = s.points || [];
        if (p.length < 2) continue;
        const cx = (p[0].x + p[1].x) / 2, cy = (p[0].y + p[1].y) / 2;
        const rx = Math.abs(p[1].x - p[0].x) / 2, ry = Math.abs(p[1].y - p[0].y) / 2;
        if (s.fill) L.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${esc(col)}"/>`);
        else L.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${esc(col)}" stroke-width="${sw}"/>`);
      }
    }
    L.push(`</svg>`);
    return L.join('\n');
  }
  // 浏览器端：触发文件下载
  function downloadBlob(name, blob) {
    if (typeof document === 'undefined') return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  const api = { strokesToSVG, downloadBlob, esc, ptsStr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.strokesToSVG = strokesToSVG, root.downloadBlob = downloadBlob;
})(typeof window !== 'undefined' ? window : null);
