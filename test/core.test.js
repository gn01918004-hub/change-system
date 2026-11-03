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
  assert.deepStrictEqual(r.cols, { name: 0, n: 1, e: 2, h: 3, code: 4, auto: true });
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
