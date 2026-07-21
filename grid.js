// CollabBoard 网格对齐（纯函数，浏览器绘制与 Node 单元测试共用）
'use strict';
// 把坐标吸附到 size 的整数倍网格；size<=0 视为关闭，原样返回。
function snapPoint(x, y, size){
  if(!(size > 0)) return [x, y];
  return [Math.round(x / size) * size, Math.round(y / size) * size];
}
// 生成网格线（CSS 像素坐标，每条 [x0,y0,x1,y1]）；size<=0 返回空数组。
function gridLines(w, h, size){
  const lines = [];
  if(!(size > 0)) return lines;
  for(let x = 0; x <= w; x += size) lines.push([x, 0, x, h]);
  for(let y = 0; y <= h; y += size) lines.push([0, y, w, y]);
  return lines;
}
if(typeof module !== 'undefined' && module.exports) module.exports = { snapPoint, gridLines };
