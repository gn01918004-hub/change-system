#!/usr/bin/env node
// 把 src/core.js、src/app.js 嵌入 src/app.html，產生單一檔案 dist/土地重測資料轉換系統.html
'use strict';
const fs = require('fs');
const path = require('path');
const root = __dirname;
const read = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');
let html = read('app.html');
for (const mark of ['/*@@CORE@@*/', '<script src="app.js"></script>']) {
  if (!html.includes(mark)) throw new Error('app.html 缺少標記 ' + mark);
}
html = html.replace('/*@@CORE@@*/', () => safe(read('core.js')));
html = html.replace('<script src="app.js"></script>', () => '<script>\n' + safe(read('app.js')) + '</script>');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const target = path.join(root, 'dist', '土地重測資料轉換系統.html');
fs.writeFileSync(target, html);
console.log('已產生', path.relative(root, target), (html.length / 1024).toFixed(1) + ' KB');
