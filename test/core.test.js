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

test('GPS CSV → CNT + MAC，反算誤差很小', () => {
  const r = Core.csvToCntMac(sample('範例_GPS.csv'), '範例_GPS.csv');
  const cnt = lines(r.files[0].content);
  assert.deepStrictEqual(cnt, ['99999 2650123.456 250987.654', '99998 2650200.120 251010.030']);
  const mac = lines(r.files[1].content);
  assert.strictEqual(mac[0], 'LS');
  assert.strictEqual(mac[1], '99999 99998');
  assert.strictEqual(mac[2], '5001.01 0.0000 0.000');
  assert.match(mac[3], /^5002\.01 0\.0000 79\.863$/);
  assert.match(mac[5], /^5004\.12 /);
  assert.ok(r.stats.maxErrMm < 1, 'maxErr ' + r.stats.maxErrMm);
});

test('GPS CSV：標題列略過、第 2 點重合時換後視點', () => {
  const csv = '點名,N,E,CD\n1,100.000,100.000,1\n2,100.000,100.000,1\n3,200.000,100.000,1\n4,100.000,200.000,1\n';
  const r = Core.csvToCntMac(csv, 'x.csv');
  assert.strictEqual(r.stats.backsight, '3');
  const mac = lines(r.files[1].content);
  assert.strictEqual(mac[5], '4.01 90.0000 100.000');
});

test('L 檔 → 全站儀 CSV（每行多點、標題自動略過、重複點只留一筆）', () => {
  const inputs = ['範例.L02', '範例.L14', '範例.L20'].map((n) => ({ name: n, text: sample(n) }));
  inputs.push({ name: 'dup.L14', text: '101 2650100.000 251000.000\n' });
  const ts = Core.lToCsv(inputs, { device: 'ts' });
  assert.deepStrictEqual(lines(ts.files[0].content), [
    '1001,2650116.723,251016.893',
    '1002,2650084.390,251026.952',
    '1003,2650112.880,250999.990',
    '101,2650100.000,251000.000',
    '2001,2650130.111,251030.222',
    '102,2650185.432,251000.000'
  ]);
  const gps = Core.lToCsv(inputs, { device: 'gps', swapXY: true });
  assert.strictEqual(lines(gps.files[0].content)[0], '101,251000.000,2650100.000');
  assert.ok(gps.files[0].name.endsWith('.csv'));
});

test('自動判斷檔案類型', () => {
  assert.strictEqual(Core.detectKind('a.RAW', ''), 'raw2mac');
  assert.strictEqual(Core.detectKind('a.txt', 'CO,x\nST,1,,2\n'), 'raw2mac');
  assert.strictEqual(Core.detectKind('a.csv', '1,2,3'), 'csv2cntmac');
  assert.strictEqual(Core.detectKind('a.l14', ''), 'l2csv');
});
