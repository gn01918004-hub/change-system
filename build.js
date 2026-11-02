#!/usr/bin/env node
// 把 src/core.js 嵌入 src/app.html，產生單一檔案 dist/土地重測資料轉換系統.html
'use strict';
const fs = require('fs');
const path = require('path');
const root = __dirname;
const core = fs.readFileSync(path.join(root, 'src', 'core.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src', 'app.html'), 'utf8');
if (!html.includes('/*@@CORE@@*/')) throw new Error('app.html 缺少 /*@@CORE@@*/ 標記');
const out = html.replace('/*@@CORE@@*/', () => core.replace(/<\/script/gi, '<\\/script'));
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const target = path.join(root, 'dist', '土地重測資料轉換系統.html');
fs.writeFileSync(target, out);
console.log('已產生', path.relative(root, target), (out.length / 1024).toFixed(1) + ' KB');
