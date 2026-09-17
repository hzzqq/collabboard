const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8099;
// CollabBoard PWA 离线测试：manifest 合法性/必需字段、icon.svg 存在、sw.js 语法与策略
// （仅 GET、/api/ 与 WS 握手放行、precache 覆盖静态壳资源）、index.html 接线
// （manifest link / theme-color / 带协议守卫的 SW 注册）、服务端 .webmanifest MIME。
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond) => cond ? pass++ : (fail++, console.log('  FAIL', name));
const dir = __dirname;
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// ---- 1) manifest.webmanifest：JSON 合法 + 必需字段 ----
let manifest = null;
try { manifest = JSON.parse(read('manifest.webmanifest')); ok('manifest JSON 合法', true); }
catch(e){ ok('manifest JSON 合法', false); }
if(manifest){
  ok('manifest name/short_name', typeof manifest.name === 'string' && typeof manifest.short_name === 'string');
  ok('manifest start_url/scope', typeof manifest.start_url === 'string' && typeof manifest.scope === 'string');
  ok('manifest display=standalone', manifest.display === 'standalone' || manifest.display === 'fullscreen' || manifest.display === 'minimal-ui');
  ok('manifest 主题/背景色', /^#[0-9a-fA-F]{6}$/.test(manifest.theme_color || '') && /^#[0-9a-fA-F]{6}$/.test(manifest.background_color || ''));
  ok('manifest icons 非空且 src 存在', Array.isArray(manifest.icons) && manifest.icons.length > 0 &&
     manifest.icons.every(ic => typeof ic.src === 'string' && fs.existsSync(path.join(dir, ic.src))));
}

// ---- 2) icon.svg：存在且为 SVG ----
const icon = read('icon.svg');
ok('icon.svg 含 <svg 根元素', /<svg[\s>]/.test(icon) && icon.includes('xmlns'));

// ---- 3) sw.js：语法 + 策略 ----
const sw = read('sw.js');
{
  const tmp = path.join(dir, '.chk_pwa_sw.js');
  fs.writeFileSync(tmp, sw);
  const { execSync } = require('child_process');
  try { execSync(`"${process.execPath}" --check "${tmp}"`, { stdio: 'pipe' }); ok('sw.js 语法 OK', true); }
  catch(e){ ok('sw.js 语法 OK', false); console.log(e.stderr && e.stderr.toString()); }
  fs.unlinkSync(tmp);
}
ok('sw.js 仅拦截 GET', /method\s*!==\s*'GET'/.test(sw));
ok('sw.js 放行 /api/', /pathname\.startsWith\('\/api\/'\)/.test(sw));
ok('sw.js 放行 WS 握手', /upgrade['"]?\)?\s*===?\s*['"]websocket['"]/.test(sw));
ok('sw.js precache 含 index/manifest/icon', ['index.html','manifest.webmanifest','icon.svg'].every(f => sw.includes(`'./${f}'`) || sw.includes(`"${f}"`)));
ok('sw.js precache 含共享脚本', ['help.js','settings.js','grid.js','history.js','store.js','svg.js'].every(f => sw.includes(f)));
ok('sw.js activate 清理旧缓存', /caches\.keys\(\)/.test(sw) && /caches\.delete/.test(sw));
ok('sw.js 缓存版本号常量', /CACHE_NAME\s*=\s*['"]collabboard-v\d+['"]/.test(sw));

// ---- 4) index.html 接线 ----
const html = read('index.html');
ok('index.html 引入 manifest', /<link[^>]+rel=["']manifest["'][^>]+href=["']manifest\.webmanifest["']/.test(html));
ok('index.html theme-color meta', /<meta[^>]+name=["']theme-color["']/.test(html));
ok('index.html 注册 SW（协议守卫）', /serviceWorker['"]\s+in\s+navigator/.test(html) && /location\.protocol/.test(html));
ok('index.html 注册失败静默降级', /\.register\(['"]sw\.js['"]\)\.catch/.test(html));

// ---- 5) 服务端 .webmanifest MIME（真实启动回查）----
function httpGet(p){
  return new Promise((resolve, reject)=>{
    const s = net.connect(PORT, 'localhost');
    let buf = '';
    s.on('connect', ()=> s.write('GET ' + p + ' HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    s.on('data', d=> buf += d.toString('utf8'));
    s.on('end', ()=>{
      const i = buf.indexOf('\r\n\r\n');
      resolve({ head: buf.slice(0, i), body: buf.slice(i + 4) });
    });
    s.on('error', reject);
  });
}
(async ()=>{
  const { spawn } = require('child_process');
  const server = spawn(process.execPath, ['server.js'], { cwd: dir, env: { ...process.env, PORT: String(PORT), HB: '999999' }, stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 700));
  try {
    const m = await httpGet('/manifest.webmanifest');
    ok('manifest 可经 HTTP 获取', m.head.includes('200 OK'));
    ok('manifest Content-Type 正确', /application\/manifest\+json/.test(m.head));
    ok('manifest 内容为合法 JSON', (()=>{ try { JSON.parse(m.body); return true; } catch(_){ return false; } })());
    const ic = await httpGet('/icon.svg');
    ok('icon 可经 HTTP 获取且 MIME 为 image/svg+xml', ic.head.includes('200 OK') && /image\/svg\+xml/.test(ic.head));
  } catch(e){
    fail++; console.log('  FAIL 异常', e.message);
  } finally {
    server.kill();
  }
  console.log(`\n[CollabBoard PWA] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
})();
