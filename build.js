#!/usr/bin/env node
// 把 src/core.js、src/app.js 嵌入 src/app.html，產生單一檔案 dist/土地重測資料轉換系統.html
'use strict';
const fs = require('fs');
const path = require('path');
const root = __dirname;
const read = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
let html = read('app.html');
for (const mark of ['/*@@INFO@@*/', '/*@@CORE@@*/', '<script src="app.js"></script>']) {
  if (!html.includes(mark)) throw new Error('app.html 缺少標記 ' + mark);
}
// 分頁小圖示：把 src/favicon.svg 直接嵌進網頁，離線也能顯示
const favicon = 'data:image/svg+xml;base64,' + Buffer.from(read('favicon.svg')).toString('base64');
if (!html.includes('@@FAVICON@@')) throw new Error('app.html 缺少標記 @@FAVICON@@');
html = html.replace('@@FAVICON@@', favicon);
const info = JSON.parse(fs.readFileSync(path.join(root, 'version.json'), 'utf8'));
html = html.replace('/*@@INFO@@*/', () => 'window.APP_INFO = ' + safe(JSON.stringify(info)) + ';');
html = html.replace('/*@@CORE@@*/', () => safe(read('core.js')));
html = html.replace('<script src="app.js"></script>', () => '<script>\n' + safe(read('app.js')) + '</script>');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const target = path.join(root, 'dist', '土地重測資料轉換系統.html');
fs.writeFileSync(target, html);
// CHANGELOG.md 由 version.json 產生，兩者保持一致
const md = ['# 更新歷程', '', '版本號與更新內容都寫在 `version.json`，執行 `npm run build` 會自動更新本檔與網頁。', '']
  .concat(...info.changelog.map((c) => ['## v' + c.version + '（' + c.date + '）', '', ...c.items.map((i) => '* ' + i), '']));
fs.writeFileSync(path.join(root, 'CHANGELOG.md'), md.join('\n'));
console.log('版本 v' + info.version);
console.log('已產生', path.relative(root, target), (html.length / 1024).toFixed(1) + ' KB');
