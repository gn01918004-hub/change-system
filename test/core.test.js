'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const Core = require('../src/core.js');

const sample = (n) => fs.readFileSync(path.join(__dirname, '..', 'samples', n), 'utf8');
const lines = (s) => s.trimEnd().split('\r\n');

test('度分秒解析與輸出（含 60 秒進位）', () => {
  assert.strictEqual(Core.dmsToSec('45.3010'), 45 * 3600 + 30 * 60 + 10);
  assert.strictEqual(Core.dmsToSec('45.30105'), 45 * 3600 + 30 * 60 + 10.5);
  assert.strictEqual(Core.dmsToSec('0'), 0);
  assert.strictEqual(Core.dmsToSec('10.6000'), null);
  assert.strictEqual(Core.secToDms(45 * 3600 + 30 * 60 + 10), '45.3010');
  assert.strictEqual(Core.secToDms(59.6), '0.0100');         // 舊 jar 會輸出 0.0060
  assert.strictEqual(Core.secToDms(3599.7), '1.0000');
  assert.strictEqual(Core.secToDms(-10), '359.5950');
  assert.strictEqual(Core.secToDms(1296000), '0.0000');
  assert.strictEqual(Core.secToDms(10.54, 1), '0.00105');
});

test('點號＋編碼格式', () => {
  assert.strictEqual(Core.formatPointName('1001', '1', 'pad2'), '1001.01');
  assert.strictEqual(Core.formatPointName('1001', '12', 'pad2'), '1001.12');
  assert.strictEqual(Core.formatPointName('1001', '', 'pad2'), '1001.00');
  assert.strictEqual(Core.formatPointName('1001', '1', 'raw'), '1001.1');
  assert.strictEqual(Core.formatPointName('99999', '1', 'pad2'), '99999');
  assert.strictEqual(Core.formatPointName('A12', '', 'pad2'), 'A12');
});

test('Nikon RAW → MAC', () => {
  const r = Core.rawToMac(sample('範例_全站儀.raw'), '範例_全站儀.raw');
  assert.strictEqual(r.stats.stations, 2);
  assert.strictEqual(r.stats.observations, 6);
  assert.strictEqual(r.stats.nonZeroStations, 1);
  const mac = r.files.find((f) => f.name === '範例_全站儀.mac');
  assert.deepStrictEqual(lines(mac.content), [
    'LS',
    '101 102',
    '102.00 0.0000 90.0010 85.432',
    '1001.01 45.3010 89.5950 23.456',
    '1002.12 120.1545 90.0120 31.207',
    '1003.05 359.5959 90.0005 12.880',
    '102 101',
    '1004.01 200.0000 90.0100 40.112',
    '1005.02 125.3015 90.0000 18.334'
  ]);
  const zero = r.files.find((f) => f.name === '範例_全站儀_Zero.mac');
  assert.deepStrictEqual(lines(zero.content).slice(6), [
    '102 101',
    '1004.01 74.2940 90.0100 40.112',
    '1005.02 359.5955 90.0000 18.334'
  ]);
  assert.ok(!r.report.some((x) => x.level === 'error'));
});

test('Nikon RAW：沒有編碼欄也不會把時間當編碼（舊 jar bug）', () => {
  const r = Core.rawToMac('ST,1,,2,,1.5,0,0\nSS,3,1.5,10.000,10.0000,90.0000,10:20:30\n', 'a.raw');
  assert.strictEqual(lines(r.files[0].content)[2], '3.00 10.0000 90.0000 10.000');
});

test('Nikon RAW：角度單位不是度分秒要報錯', () => {
  const r = Core.rawToMac('CO,Angle Units: Gons\nST,1,,2,,1.5,0,0\nSS,3,1.5,10,10.0000,90.0000,1,1\n', 'a.raw');
  assert.ok(r.report.some((x) => x.level === 'error' && /角度單位/.test(x.msg)));
});

test('GPS CSV（控制器原始檔）：自動剔除核對點與雜點、去掉高程欄', () => {
  const r = Core.csvToCntMac(sample('範例_GPS.csv'), '範例_GPS.csv');
  assert.deepStrictEqual(r.cols, { name: 0, n: 1, e: 2, h: 3, code: 4, auto: true, swapNE: false });
  assert.strictEqual(r.stats.points, 4);
  assert.strictEqual(r.stats.excluded, 4);
  const byName = Object.fromEntries(r.points.map((p) => [p.name, p]));
  assert.deepStrictEqual(byName.BAC026.flags, ['check']);
  assert.deepStrictEqual(byName['193'].flags, ['junk']);
  const cnt = lines(r.files[0].content);
  assert.deepStrictEqual(cnt, ['99999 2650123.456 250987.654', '99998 2650200.120 251010.030']);
  const mac = lines(r.files[1].content);
  assert.strictEqual(mac[0], 'LS');
  assert.strictEqual(mac[1], '99999 99998');
  assert.strictEqual(mac[2], '5001.01 0.0000 0.000');
  assert.match(mac[3], /^5002\.01 0\.0000 79\.863$/);
  assert.match(mac[5], /^5004\.12 /);
  assert.ok(r.stats.maxErrMm < 1, 'maxErr ' + r.stats.maxErrMm);
  // 整理後的 CSV：與 Excel 存出的格式相同（點名,N,E,編碼，去掉多餘的 0）
  assert.deepStrictEqual(lines(r.files[2].content), [
    '5001,2650123.456,250987.654,1',
    '5002,2650200.12,251010.03,1',
    '5003,2650150.789,250900.111,3',
    '5004,2650080.002,250950.5,12'
  ]);
});

test('GPS CSV：整理後的檔再轉一次結果相同；使用者可改變剔除決定', () => {
  const raw = Core.csvToCntMac(sample('範例_GPS.csv'), 'a.csv');
  const again = Core.csvToCntMac(raw.files[2].content, 'a.csv');
  assert.strictEqual(again.cols.code, 3);
  assert.strictEqual(again.files[1].content, raw.files[1].content);
  // 把核對點 GC06（第 3 行）改成要轉換：會出現在 MAC，並提醒
  const r = Core.csvToCntMac(sample('範例_GPS.csv'), 'a.csv', { decisions: { 3: true } });
  assert.strictEqual(r.stats.points, 5);
  assert.ok(lines(r.files[1].content).some((l) => l.startsWith('GC06 ')));
  assert.ok(r.report.some((x) => x.level === 'warn' && /GC06/.test(x.msg)));
});

test('GPS CSV：離群點與重複點名預設剔除', () => {
  const csv = ['1,1000.000,1000.000,1', '2,1010.000,1000.000,1', '3,1005.000,1008.000,1', '4,1003.000,1002.000,1',
    '5,9000.000,9000.000,1', '3,1006.000,1009.000,1'].join('\n');
  const r = Core.csvToCntMac(csv, 'x.csv');
  const p5 = r.points.find((p) => p.name === '5');
  assert.ok(p5.flags.includes('far') && !p5.include);
  const dup = r.points.filter((p) => p.name === '3')[1];
  assert.ok(dup.flags.includes('dup') && !dup.include);
  assert.strictEqual(r.stats.points, 4);
});

test('GPS CSV：標題列略過、第 2 點重合時換後視點', () => {
  const csv = '點名,N,E,CD\n1,100.000,100.000,1\n2,100.000,100.000,1\n3,200.000,100.000,1\n4,100.000,200.000,1\n';
  const r = Core.csvToCntMac(csv, 'x.csv');
  assert.strictEqual(r.stats.backsight, '3');
  const mac = lines(r.files[1].content);
  assert.strictEqual(mac[5], '4.01 90.0000 100.000');
});

test('L 檔 → 儀器 CSV（控制點→界址→補點、每行多點、標題自動略過、重複點只留一筆）', () => {
  const inputs = ['範例.L14', '範例.L20', '範例.L02'].map((n) => ({ name: n, text: sample(n) }));
  inputs.push({ name: 'dup.L14', text: '101 2650100.000 251000.000\n' });
  const r = Core.lToCsv(inputs);
  assert.deepStrictEqual(lines(r.files[0].content), [
    '101,2650100.000,251000.000',
    '102,2650185.432,251000.000',
    '1001,2650116.723,251016.893',
    '1002,2650084.390,251026.952',
    '1003,2650112.880,250999.990',
    '2001,2650130.111,251030.222'
  ]);
  assert.strictEqual(r.files.length, 1);
  assert.ok(r.files[0].name.endsWith('.csv'));
  const sw = Core.lToCsv(inputs, { swapXY: true, ext: 'txt' });
  assert.strictEqual(lines(sw.files[0].content)[0], '101,251000.000,2650100.000');
  assert.ok(sw.files[0].name.endsWith('.txt'));
});

test('自動判斷檔案類型', () => {
  assert.strictEqual(Core.detectKind('a.RAW', ''), 'raw2mac');
  assert.strictEqual(Core.detectKind('a.txt', 'CO,x\nST,1,,2\n'), 'raw2mac');
  assert.strictEqual(Core.detectKind('a.csv', '1,2,3'), 'csv2cntmac');
  assert.strictEqual(Core.detectKind('a.l14', ''), 'l2csv');
});

test('Nikon RAW：用 UP 已知坐標推算點位並做後視檢核', () => {
  const raw = ['CO,Angle Units: DDDMMSS', 'UP,A,,1000.000,1000.000,,', 'UP,B,,1100.000,1000.000,,',
    'ST,A,,B,,0.0000,0.0000,0.0000', 'F1,B,0.0000,100.002,0.0000,90.0000,1', 'SS,P,0.0000,10.000,90.0000,90.0000,1,3',
    'ST,P,,A,,0.0000,0.0000,0.0000', 'SS,Q,0.0000,10.000,90.0000,90.0000,1,3'].join('\n');
  const r = Core.rawToMac(raw, 'a.raw');
  const P = r.plot.points.find((p) => p.name === 'P' && p.kind === 'obs');
  assert.ok(Math.abs(P.N - 1000) < 1e-6 && Math.abs(P.E - 1010) < 1e-6);
  const Q = r.plot.points.find((p) => p.name === 'Q');
  assert.ok(Math.abs(Q.N - 1010) < 1e-6 && Math.abs(Q.E - 1010) < 1e-6, JSON.stringify(Q));
  assert.ok(r.report.some((x) => /後視 B 檢核.*差 2 mm/.test(x.msg)));
});

test('資料夾掃描：同資料夾同主檔名的 L 檔合為一組', () => {
  const g = Core.groupFolderFiles([
    { name: 'KC0390.L02', path: 'job/KC0390.L02' }, { name: 'KC0390.L14', path: 'job/KC0390.L14' },
    { name: 'kc0390.L20', path: 'job/kc0390.L20' }, { name: 'KC0390.L14', path: 'job/old/KC0390.L14' },
    { name: 'a.RAW', path: 'job/a.RAW' }, { name: 'b.csv', path: 'job/b.csv' }, { name: 'x.doc', path: 'job/x.doc' }
  ]);
  assert.deepStrictEqual(g.l2csv.map((x) => [x.label, x.dir, x.exts]), [
    ['KC0390', 'job', ['L02', 'L14', 'L20']], ['KC0390', 'job/old', ['L14']]
  ]);
  assert.strictEqual(g.raw2mac.length, 1);
  assert.strictEqual(g.csv2cntmac.length, 1);
});

test('L 檔：每行 3 點、PAGE 標題列、點號 .0 去掉', () => {
  const t = 'PAGE 1/2\r\n  4240.0     2701039.308   218159.992     4569.0     2701011.383   218122.205     4653.0     2701058.068   218175.406   \r\n\r\nPAGE 2/2\r\n  4711.0     2701061.516   218184.435\r\n';
  const r = Core.lToCsv([{ name: 'K.L14', text: t }]);
  assert.deepStrictEqual(lines(r.files[0].content), ['4240,2701039.308,218159.992', '4569,2701011.383,218122.205', '4653,2701058.068,218175.406', '4711,2701061.516,218184.435']);
});

test('GPS CSV：點名,E,N 順序自動對調，也可以強制指定', () => {
  const en = ['1,218704.317,2706766.984,10', '2,218635.348,2706854.423,10', '3,218556.709,2706933.861,11'].join('\n');
  const r = Core.csvToCntMac(en, 'x.csv');
  assert.strictEqual(r.cols.swapNE, true);
  assert.deepStrictEqual(lines(r.files[0].content), ['99999 2706766.984 218704.317', '99998 2706854.423 218635.348']);
  assert.ok(r.report.some((x) => x.level === 'warn' && /對調/.test(x.msg)));
  // 正常的 點名,N,E 不會被動到
  const ne = Core.csvToCntMac(sample('範例_GPS.csv'), 'a.csv');
  assert.strictEqual(ne.cols.swapNE, false);
  // 強制指定
  assert.strictEqual(Core.csvToCntMac(en, 'x.csv', { neOrder: 'ne' }).cols.swapNE, false);
  assert.strictEqual(Core.csvToCntMac(sample('範例_GPS.csv'), 'a.csv', { neOrder: 'en' }).cols.swapNE, true);
});

test('GPS CSV：編碼不是 00～99 自動改成 11，並產生編碼對照表', () => {
  const csv = ['BE73,2698533.357,219360.962,0.000,', '1,2698533.370,219360.900,91.735,be73',
    '2,2698542.722,219365.770,111.293,30', '3,2698541.044,219367.690,112.276,30', '13,2698553.822,219336.041,111.223,q11'].join('\n');
  const r = Core.csvToCntMac(csv, 'a.csv');
  const mac = lines(r.files.find((f) => f.name === 'a.mac').content);
  assert.ok(mac.some((l) => l.startsWith('1.11 ')));
  // q11 是 Q 開頭的編碼 → 編碼本身就是補點名稱 Q11
  assert.ok(mac.some((l) => l.startsWith('Q11 ')));
  assert.strictEqual(r.stats.recoded, 2);
  const table = r.files.find((f) => f.name === 'a_編碼對照表.csv').content;
  assert.ok(table.startsWith('﻿原點名,原編碼,重測系統點號'));
  assert.ok(table.includes('1,be73,1.11,'));
  assert.ok(table.includes('13,q11,Q11,'));
  // 整理後的 CSV 也是改過的編碼
  assert.ok(r.files.find((f) => f.name === 'a_整理.csv').content.includes('1,2698533.37,219360.9,11'));
  // 可以改成別的號碼，也可以個別指定
  const r2 = Core.csvToCntMac(csv, 'a.csv', { badCodeTo: '12', codeOverrides: { 5: '7' } });
  const mac2 = lines(r2.files.find((f) => f.name === 'a.mac').content);
  assert.ok(mac2.some((l) => l.startsWith('1.12 ')));
  assert.ok(mac2.some((l) => l.startsWith('Q11 ')));
});

test('GPS CSV：沒有編碼但有高程的點要使用者決定編碼', () => {
  const csv = ['BE73,2698533.357,219360.962,0.000,', '2,2698542.722,219365.770,111.293,30',
    '3,2698541.044,219367.690,112.276,30', '8,2698543.499,219383.903,112.117,'].join('\n');
  const r = Core.csvToCntMac(csv, 'a.csv');
  const p8 = r.points.find((p) => p.name === '8');
  assert.deepStrictEqual(p8.flags, ['ask']);
  assert.ok(p8.include);
  assert.strictEqual(r.stats.pending, 1);
  assert.ok(r.points.find((p) => p.name === 'BE73').flags.includes('check'));   // 高程 0 的核對點仍然剔除
  const r2 = Core.csvToCntMac(csv, 'a.csv', { noCodeAs: '5' });
  assert.strictEqual(r2.stats.pending, 0);
  assert.ok(lines(r2.files.find((f) => f.name === 'a.mac').content).some((l) => l.startsWith('8.05 ')));
  assert.ok(r2.files.find((f) => f.name === 'a_編碼對照表.csv').content.includes('8,,8.05,'));
});

test('L 檔：依數值判斷 Y（27…）、X（21…），輸出順序可選 Y,X（預設）或 X,Y', () => {
  assert.strictEqual(Core.classifyYX('2701039.308', '218159.992'), 'yx');
  assert.strictEqual(Core.classifyYX('218159.992', '2701039.308'), 'xy');
  assert.strictEqual(Core.classifyYX('1000.000', '1010.000'), null);
  // 同一行裡一點 Y 在前、一點 X 在前
  const t = '4240.0  2701039.308  218159.992   4569.0  218122.205  2701011.383\n';
  const r = Core.lToCsv([{ name: 'K.L14', text: t }]);
  assert.strictEqual(r.order, 'yx');
  assert.deepStrictEqual(lines(r.files[0].content), ['4240,2701039.308,218159.992', '4569,2701011.383,218122.205']);
  assert.ok(r.report.some((x) => /X 在前/.test(x.msg)));
  const xy = Core.lToCsv([{ name: 'K.L14', text: t }], { order: 'xy' });
  assert.deepStrictEqual(lines(xy.files[0].content), ['4240,218159.992,2701039.308', '4569,218122.205,2701011.383']);
  assert.match(xy.files[0].desc, /點號,X,Y/);
  // 看不出來的假設坐標：照原順序並提醒
  const loc = Core.lToCsv([{ name: 'K.L14', text: '1 1000.000 1010.000\n' }]);
  assert.strictEqual(lines(loc.files[0].content)[0], '1,1000.000,1010.000');
  assert.ok(loc.report.some((x) => x.level === 'warn' && /看不出/.test(x.msg)));
});

test('複丈輸入檔：COA + CTL + BNP + PAR → CSV，可依地號挑選、控制點取周圍', () => {
  const coa = 'KC9999 3 500 3\r\n    1 2707758.00200000219829.249000000\r\n    2 2707565.58200000220573.485000000\r\n    3 2707796.09100000219898.484000004\r\n';
  const ctl = 'KCK030000000\r\nBKC001  2707760.653219830.2200 \r\nBKC002  2700000.822210000.6008 \r\n';
  const par = 'KC9999 113111310231131\r\n' +
    '   1   01117    390.21   1   0    390.21J 02707859.2219916.3  0\r\n' +
    '   2   01117   2278.00   2   0   2278.00J 02707822.1219920.5  0\r\n' +
    '1000   01117      6.631000   0      6.63U 02707000.4220190.4  0\r\n';
  const bnp = 'KC9999 3\r\n   1   0  1   2     1     3                                                      \r\n' +
    '   2   0  1   1     2                                                            \r\n' +
    '1000   0  1   1     2                                                            \r\n';
  const inputs = [{ name: 'KC9999.COA', text: coa }, { name: 'KC9999.CTL', text: ctl }, { name: 'KC9999.PAR', text: par }, { name: 'KC9999.BNP', text: bnp }];
  const all = Core.coaToCsv(inputs);
  assert.deepStrictEqual(lines(all.files[0].content), [
    'BKC001,2707760.653,219830.220', 'BKC002,2700000.822,210000.600',
    '1,2707758.002,219829.249', '2,2707565.582,220573.485', '3,2707796.091,219898.484'
  ]);
  assert.deepStrictEqual(all.parcels.map((p) => p.key), ['1', '2', '1000']);
  assert.strictEqual(all.parcels[2].area, '6.63');       // 4 位數母號，面積不會黏在一起
  // 只要地號 1，控制點取最近 1 點，界址點在前，X,Y；檔名加上地號（同舊程式）
  const r = Core.coaToCsv(inputs, { parcels: ['0001'], ctl: 'nearest', nearestN: 1, ctlFirst: false, order: 'xy', ext: 'txt' });
  assert.deepStrictEqual(lines(r.files[0].content), ['1,219829.249,2707758.002', '3,219898.484,2707796.091', 'BKC001,219830.220,2707760.653']);
  assert.strictEqual(r.files[0].name, 'KC99991.txt');
  assert.match(r.ctlList.find((c) => c.name === 'BKC001').auto, /地號 1 最近/);
  // 手動：拿掉自動選的、加入別的
  const m = Core.coaToCsv(inputs, { parcels: ['1'], ctl: 'nearest', nearestN: 1, ctlRemove: ['BKC001'], ctlAdd: ['BKC002'] });
  assert.deepStrictEqual(m.ctlList.filter((c) => c.selected).map((c) => c.name), ['BKC002']);
  assert.strictEqual(Core.parcelKeyOf('0012-0003'), '12-3');
  assert.strictEqual(Core.parcelKeyOf('12之3'), '12-3');
  // 缺 .COA
  assert.ok(Core.coaToCsv([{ name: 'X.CTL', text: ctl }]).report.some((x) => x.level === 'error'));
  // 資料夾掃描與自動判斷
  const g = Core.groupFolderFiles(inputs.map((f) => ({ name: f.name, path: 'job/' + f.name })));
  assert.strictEqual(g.coa2csv.length, 1);
  assert.strictEqual(Core.detectKind('a.COA', ''), 'coa2csv');
});

test('SOKKIA .sdr 與 TOPCON .txt 格式（同「複丈輸入檔2SOKKIA」）', () => {
  const pts = [{ name: 'BKC001', y: '2707539.653', x: '219629.220' }, { name: '4', y: '2707849.009', x: '219902.876' }];
  const sdr = Core.writePoints(pts, 'KC11171_2_3', { format: 'sdr', now: new Date(2026, 10, 3, 11, 6) }, '');
  assert.strictEqual(sdr.name, 'KC11171_2_3.sdr');
  assert.strictEqual(sdr.content,
    '\uFEFF00NMSDR33 V04-04.02     03-Nov-26 11:06 111111\r\n' +
    '10NM                121111\r\n' +
    '08KIBKC001          2707539.653     219629.220      0.              1               \r\n' +
    '08KI4               2707849.009     219902.876      0.              1               \r\n');
  const tc = Core.writePoints(pts, 'KC11171_2_3', { format: 'topcon' }, '');
  assert.strictEqual(tc.name, 'KC11171_2_3.txt');
  assert.strictEqual(tc.content, 'BKC001,2707539.653,219629.220,0.000,1\r\n4,2707849.009,219902.876,0.000,1\r\n');
  // 重測資料（L 檔）也能輸出 SOKKIA
  const l = Core.lToCsv([{ name: 'K.L02', text: 'BC13  2700703.742  218447.786\n' }], { format: 'sdr', now: new Date(2026, 0, 5, 8, 3) });
  assert.ok(l.files[0].name.endsWith('.sdr'));
  assert.ok(l.files[0].content.includes('05-Jan-26 08:03'));
});

// 做一個最小的 dBASE III 檔（欄位同重測系統的 D14 / D20）
function makeDbf(fields, rows) {
  const hlen = 32 + fields.length * 32 + 1, rlen = 1 + fields.reduce((a, f) => a + f[2], 0);
  const buf = Buffer.alloc(hlen + rlen * rows.length, 0);
  buf[0] = 3; buf[1] = 124; buf[2] = 10; buf[3] = 30;
  buf.writeUInt32LE(rows.length, 4); buf.writeUInt16LE(hlen, 8); buf.writeUInt16LE(rlen, 10);
  fields.forEach((f, i) => { buf.write(f[0], 32 + i * 32, 'latin1'); buf.write(f[1], 32 + i * 32 + 11, 'latin1'); buf[32 + i * 32 + 16] = f[2]; buf[32 + i * 32 + 17] = f[3]; });
  buf[hlen - 1] = 0x0d;
  rows.forEach((r, i) => buf.write(r, hlen + i * rlen, 'latin1'));
  return new Uint8Array(buf);
}
const D14F = [['COT_NUMBER', 'N', 5, 0], ['COT_REF', 'N', 2, 0], ['COT_Y', 'N', 16, 8], ['COT_X', 'N', 15, 8], ['COT_MATTER', 'N', 2, 0],
  ['COT_SOURCE', 'N', 1, 0], ['COT_SURVEY', 'N', 2, 0], ['COT_MSE', 'N', 2, 0], ['COT_REMARK', 'C', 12, 0], ['TAU_ID', 'N', 3, 0]];
const D20F = [['CTL_NAME', 'C', 8, 0], ['CTL_Y', 'N', 12, 3], ['CTL_X', 'N', 11, 3], ['CTL_LEVEL', 'C', 3, 0], ['CTL_MATTER', 'C', 1, 0],
  ['CTL_SITUAT', 'C', 1, 0], ['CTL_LAND', 'C', 1, 0], ['CTL_MODE', 'L', 1, 0]];

test('寫入重測系統檔：D14 參考點、D20 補點、點號重複自動改號', () => {
  const d14 = Core.parseDbf(makeDbf(D14F, [
    '     1 02704480.54200000219713.24700000 30 0 0                  ',
    '     1322704014.79600000219334.51900000 01 0 0                  ',
    '     2302704022.00300000219315.27000000 01 0 0                  '
  ]));
  const d20 = Core.parseDbf(makeDbf(D20F, [' QW1      2704020.768 219351.358Q  \0\0\0T']));
  assert.strictEqual(d14.nrec, 3);
  const plan = Core.planDbfWrite({ d14, d20, points: [
    { key: 'a', name: '1', code: '32', y: 2704000.1, x: 219300.2, src: 'GPS' },   // 1.32 已有 → 2.32
    { key: 'b', name: '7', code: '30', y: 2704001.1, x: 219301.2, src: 'GPS' },   // 新增 7.30
    { key: 'c', name: 'QW1', code: '', y: 2704002.1, x: 219302.2, src: '全站儀' }, // QW1 已有 → QW2
    { key: 'd', name: '8', code: null, y: 2704003.1, x: 219303.2, src: 'GPS' },    // 缺編碼
    { key: 'e', name: 'BE73', code: '11', y: 2704004.1, x: 219304.2, src: 'GPS' }  // 不能寫
  ] });
  const by = Object.fromEntries(plan.rows.map((r) => [r.key, r]));
  assert.strictEqual(by.a.out, '2.32'); assert.strictEqual(by.a.status, 'renumbered');
  assert.strictEqual(by.b.out, '7.30'); assert.strictEqual(by.b.status, 'new');
  assert.strictEqual(by.c.out, 'QW2'); assert.strictEqual(by.c.target, 'D20');
  assert.strictEqual(by.d.status, 'needCode');
  assert.strictEqual(by.e.status, 'skip');
  assert.strictEqual(plan.blocking.length, 1);
  // 補上編碼、拿掉不要的
  const plan2 = Core.planDbfWrite({ d14, d20, points: plan.rows.map((r) => ({ key: r.key, name: r.origName, code: r.origCode === '' ? (r.key === 'c' ? '' : null) : r.origCode, y: r.y, x: r.x, src: r.src })),
    edits: { d: { ref: '33' }, b: { skip: true } } });
  assert.strictEqual(plan2.blocking.length, 0);
  const out = Core.buildDbfFiles(plan2, d14, d20, new Date(2026, 10, 3));
  const n14 = Core.parseDbf(out.d14), n20 = Core.parseDbf(out.d20);
  assert.strictEqual(n14.nrec, 5);
  assert.strictEqual(n14.u8[1], 126); assert.strictEqual(n14.u8[2], 11); assert.strictEqual(n14.u8[3], 3);
  assert.deepStrictEqual(n14.records.slice(3).map((r) => r.values.COT_NUMBER + r.values.COT_REF + r.values.COT_Y + r.values.COT_X + r.values.COT_MATTER + r.values.COT_SOURCE),
    ['    2322704000.10000000219300.20000000 02', '    8332704003.10000000219303.20000000 02']);
  assert.strictEqual(Buffer.from(out.d20.subarray(out.d20.length - 39)).toString('latin1'), ' QW2      2704002.100 219302.200Q  \0\0\0T');
  assert.ok(out.table.startsWith('﻿原點名,原編碼,寫入檔案,寫入點號'));
  // 原檔前面的位元組一個都沒動
  assert.deepStrictEqual(Array.from(out.d14.subarray(32, d14.hlen + 3 * d14.rlen)), Array.from(d14.u8.subarray(32)));
});

test('全站儀 RAW 可以用 D14/D20 的已知坐標算出新點', () => {
  const raw = ['ST,QW1,,QW2,,0.0000,0.0000,0.0000', 'F1,QW2,0.0000,100.000,0.0000,90.0000,1', 'SS,9,0.0000,10.000,90.0000,90.0000,1,30', 'SS,QW9,0.0000,20.000,180.0000,90.0000,1,'].join('\n');
  // D14 已有 9 號界址點（編碼 0）；RAW 觀測的 9 號編碼 30 是新點，不能當成已知點略過
  const d14 = Core.parseDbf(makeDbf(D14F, ['     9 02704480.54200000219713.24700000 30 0 0                  ']));
  const known = Core.knownFromDbf(d14, Core.parseDbf(makeDbf(D20F, [' QW1         1000.000   1000.000Q  \0\0\0T', ' QW2         1100.000   1000.000Q  \0\0\0T'])));
  const r = Core.rawToMac(raw, 'a.raw', { known });
  const p9 = r.plot.obs.find((o) => o.pt === '9');
  assert.ok(Math.abs(p9.N - 1000) < 1e-6 && Math.abs(p9.E - 1010) < 1e-6);
  assert.strictEqual(p9.wasKnown, false);
  const q9 = r.plot.obs.find((o) => o.pt === 'QW9');
  assert.ok(Math.abs(q9.N - 980) < 1e-6 && Math.abs(q9.E - 1000) < 1e-6);
});

test('GPS CSV 補點：Q 開頭有高程、或編碼寫 Q 開頭；沒有高程的 Q 點是系統原有點', () => {
  const csv = ['3531,2704091.691,219309.397,0,', 'QW1,2704020.768,219351.358,0,', 'GGC32,2704014.769,219334.583,0,',
    'QGGC32,2704014.796,219334.519,97.082,', '2,2704022.003,219315.27,121.03,30', '3,2704012.859,219317.843,120.963,30',
    '12,2704027.882,219294.88,118.265,QW'].join('\n');
  const r = Core.csvToCntMac(csv, 'a.csv');
  assert.strictEqual(r.cols.h, 3);                       // 高程寫成「0」也認得出是高程欄
  const by = Object.fromEntries(r.points.map((p) => [p.name, p]));
  assert.ok(by['3531'].flags.includes('check') && !by['3531'].include);
  assert.ok(by.QW1.flags.includes('check') && !by.QW1.include);   // 沒有高程 → 系統原有點
  assert.ok(by.QGGC32.supp && by.QGGC32.include && !by.QGGC32.flags.length);
  assert.ok(by.QW12 && by.QW12.supp && by.QW12.renamedFrom === '12');
  assert.strictEqual(r.stats.pending, 0);
  const mac = lines(r.files.find((f) => f.name === 'a.mac').content);
  assert.ok(mac.some((l) => l.startsWith('QGGC32 ')) && mac.some((l) => l.startsWith('QW12 ')) && mac.some((l) => l.startsWith('2.30 ')));
  assert.ok(r.files.find((f) => f.name === 'a_編碼對照表.csv').content.includes('12,QW,QW12,'));
  assert.ok(Core.csvToCntMac('5,2704000.1,219300.1,100.1,QW5\n6,2704001.1,219301.1,100.2,30\n7,2704002.1,219302.1,100.3,30', 'b.csv').points[0].name === 'QW5');
  // 寫入時：補點進 D20、參考點進 D14
  const d14 = Core.parseDbf(makeDbf(D14F, ['     1 02704480.54200000219713.24700000 30 0 0                  ']));
  const d20 = Core.parseDbf(makeDbf(D20F, [' QW1      2704020.768 219351.358Q  \0\0\0T']));
  const plan = Core.planDbfWrite({ d14, d20, points: r.points.filter((p) => p.include).map((p) => ({ key: p.line, name: p.name, code: p.useCode || null, y: p.N, x: p.E, src: 'GPS' })) });
  assert.deepStrictEqual(plan.toD20.map((x) => x.out).sort(), ['QGGC32', 'QW12']);
  assert.deepStrictEqual(plan.toD14.map((x) => x.out), ['2.30', '3.30']);
});
