/*
 * 土地重測資料轉換系統 — 轉換核心
 *
 * 整合並改寫自下列舊工具：
 *   RawToMACV2.0.jar             Nikon RAW  → MAC（含後視歸零 _Zero.mac）
 *   NIKON 轉 MAC 0714F5.xls      Nikon RAW  → MAC（點號＋編碼、自由測站提示）
 *   CSV TO 重測 CT02.xls         GPS/VRS CSV → CNT + MAC（虛擬測站 99999 / 99998）
 *   TrimblePointInputV3.jar      L02/L14/L20 → GPS 控制器 CSV
 *   重測 → CSV TS01.xls          L14/L20/L02 → 全站儀 CSV
 *
 * 本檔可同時在瀏覽器（window.Core）與 Node（require）中使用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EOL = '\r\n';
  var STATION_ID = '99999';
  var BACKSIGHT_ID = '99998';
  var FULL_CIRCLE_SEC = 1296000; // 360 * 3600

  // ───────────────────────── 共用工具 ─────────────────────────

  function splitLines(text) {
    return String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/);
  }

  function isNum(s) {
    return typeof s === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s.trim());
  }

  function stripQuotes(s) {
    s = (s == null ? '' : String(s)).trim();
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
    return s;
  }

  function baseName(filename) {
    var n = String(filename || '').replace(/^.*[\\/]/, '');
    var i = n.lastIndexOf('.');
    return i > 0 ? n.slice(0, i) : n || '未命名';
  }

  function extName(filename) {
    var m = /\.([^.\\/]+)$/.exec(String(filename || ''));
    return m ? m[1].toUpperCase() : '';
  }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  /** 把多行組成檔案內容（Windows 換行，最後一行也換行）。 */
  function joinLines(lines) {
    return lines.join(EOL) + EOL;
  }

  function Report() {
    this.items = [];
  }
  Report.prototype.add = function (level, msg, line) {
    this.items.push({ level: level, msg: msg, line: line || null });
  };
  Report.prototype.error = function (m, l) { this.add('error', m, l); };
  Report.prototype.warn = function (m, l) { this.add('warn', m, l); };
  Report.prototype.info = function (m, l) { this.add('info', m, l); };
  Report.prototype.count = function (level) {
    return this.items.filter(function (x) { return x.level === level; }).length;
  };

  // ─────────────────────── 角度（度.分秒） ───────────────────────

  /**
   * 解析「度.分秒」字串（例如 "45.3010" = 45°30'10"，"45.30105" = 45°30'10.5"）。
   * 回傳總秒數；格式錯誤回傳 null。
   */
  function dmsToSec(str) {
    var s = String(str == null ? '' : str).trim();
    if (!isNum(s)) return null;
    var neg = s[0] === '-';
    if (s[0] === '-' || s[0] === '+') s = s.slice(1);
    var parts = s.split('.');
    var d = parseInt(parts[0] || '0', 10);
    var f = (parts[1] || '');
    while (f.length < 4) f += '0';
    var m = parseInt(f.slice(0, 2), 10);
    var sec = parseFloat(f.slice(2, 4) + '.' + (f.slice(4) || '0'));
    if (m >= 60 || sec >= 60) return null;
    var total = d * 3600 + m * 60 + sec;
    return neg ? -total : total;
  }

  /** 角度字串中秒數的小數位數（"45.30105" → 1）。 */
  function dmsSecDecimals(str) {
    var parts = String(str).trim().split('.');
    return Math.max(0, ((parts[1] || '').length) - 4);
  }

  /**
   * 總秒數 → 「度.分秒」字串，自動化到 0~360 度，秒數四捨五入到 secDecimals 位，
   * 不會出現 60 秒、60 分的進位錯誤（舊版 jar 的 bug）。
   */
  function secToDms(totalSec, secDecimals) {
    var k = secDecimals || 0;
    var p = Math.pow(10, k);
    var full = FULL_CIRCLE_SEC * p;
    var u = Math.round(totalSec * p);
    u = ((u % full) + full) % full;
    var d = Math.floor(u / (3600 * p));
    u -= d * 3600 * p;
    var m = Math.floor(u / (60 * p));
    u -= m * 60 * p;
    var sInt = Math.floor(u / p);
    var sFrac = u - sInt * p;
    return d + '.' + pad(m, 2) + pad(sInt, 2) + (k > 0 ? pad(sFrac, k) : '');
  }

  /** 方位角（由北順時針），回傳秒。 */
  function azimuthSec(dN, dE) {
    var a = Math.atan2(dE, dN) * 180 / Math.PI;
    if (a < 0) a += 360;
    return a * 3600;
  }

  // ─────────────────────── 點號＋編碼 ───────────────────────

  /**
   * 重測系統 MAC 的點號格式：「點號.編碼」。
   *   codeMode = 'pad2'（預設，同 Excel 版）：編碼補成兩位，5 → 123.05，空白 → 123.00
   *   codeMode = 'raw' （同舊 jar 版）      ：照原樣接上，5 → 123.5，空白 → 123.0
   * 點號 ≥ 99999 或不是整數（例如 A12）時不加編碼。
   */
  function formatPointName(pt, code, codeMode, report, lineNo) {
    pt = String(pt == null ? '' : pt).trim();
    code = String(code == null ? '' : code).trim();
    if (!/^\d+$/.test(pt) || parseInt(pt, 10) >= 99999) {
      if (code !== '' && !/^\d+$/.test(pt) && report) {
        report.warn('點號「' + pt + '」不是數字，無法加上編碼「' + code + '」，保留原點號', lineNo);
      }
      return pt;
    }
    if (/^\d+\.0*$/.test(code)) code = String(parseInt(code, 10));
    if (code === '') return pt + (codeMode === 'raw' ? '.0' : '.00');
    if (!/^\d+$/.test(code)) {
      if (report) report.warn('點號 ' + pt + ' 的編碼「' + code + '」不是數字（重測系統無法判別），已改為 00，請確認', lineNo);
      return pt + (codeMode === 'raw' ? '.0' : '.00');
    }
    if (codeMode === 'raw') return pt + '.' + code;
    if (code.length > 2) {
      if (report) report.warn('點號 ' + pt + ' 的編碼「' + code + '」超過兩位數，請確認', lineNo);
      return pt + '.' + code;
    }
    return pt + '.' + pad(code, 2);
  }

  // ═════════════ 1. Nikon RAW → MAC（全站儀 → 重測系統） ═════════════

  /**
   * Nikon RAW 記錄（逗號分隔）：
   *   CO,註記
   *   ST,測站,,後視點,,儀器高,後視方位,後視水平角
   *   F1,點號,稜鏡高,斜距,水平角,天頂角,時間        （後視觀測）
   *   SS,點號,稜鏡高,斜距,水平角,天頂角,時間,編碼   （前視觀測）
   *   RE,點號,N,E,...                                （自由測站，需自行加入重測系統）
   */
  function parseNikonRaw(text, report) {
    var lines = splitLines(text);
    var sessions = [];
    var freeStations = [];
    var cur = null;
    var meta = { angleUnits: '', distUnits: '' };

    lines.forEach(function (raw, idx) {
      var lineNo = idx + 1;
      var line = raw.trim();
      if (!line) return;
      var f = line.split(',').map(stripQuotes);
      var type = f[0].toUpperCase();

      if (type === 'CO') {
        var co = f.slice(1).join(',');
        var am = /Angle\s*Units\s*:\s*(.+)$/i.exec(co);
        if (am) meta.angleUnits = am[1].trim();
        var dm = /Dist\s*Units\s*:\s*(.+)$/i.exec(co);
        if (dm) meta.distUnits = dm[1].trim();
        return;
      }
      if (type === 'ST') {
        cur = {
          station: f[1] || '',
          back: (f[2] || '') !== '' ? f[2] : (f[3] || ''),
          hi: f[5] || '',
          line: lineNo,
          obs: [],
          backObs: null
        };
        if (!cur.station) report.error('測站點號是空的', lineNo);
        if (!cur.back) report.warn('測站 ' + cur.station + ' 沒有後視點號', lineNo);
        sessions.push(cur);
        return;
      }
      if (type === 'F1' || type === 'F2') {
        if (cur && !cur.backObs && f[1] === cur.back) {
          cur.backObs = { ha: f[4] || '', line: lineNo, src: type };
        }
        return;
      }
      if (type === 'SS') {
        if (!cur) {
          report.error('觀測資料出現在任何測站（ST）之前，已略過', lineNo);
          return;
        }
        var o = {
          pt: f[1] || '',
          ht: f[2] || '',
          sd: f[3] || '',
          ha: f[4] || '',
          va: f[5] || '',
          code: f[7] || '',
          line: lineNo
        };
        if (!o.pt) { report.error('觀測點號是空的，已略過', lineNo); return; }
        if (dmsToSec(o.ha) === null) report.error('點 ' + o.pt + ' 水平角「' + o.ha + '」格式錯誤', lineNo);
        if (dmsToSec(o.va) === null) report.error('點 ' + o.pt + ' 天頂角「' + o.va + '」格式錯誤', lineNo);
        if (!isNum(o.sd)) report.error('點 ' + o.pt + ' 斜距「' + o.sd + '」不是數字', lineNo);
        cur.obs.push(o);
        return;
      }
      if (type === 'RE') {
        freeStations.push({ name: f[1] || '', n: f[2] || '', e: f[3] || '', line: lineNo });
        return;
      }
    });

    if (meta.angleUnits && !/DDDMMSS|DMS/i.test(meta.angleUnits.replace(/[^A-Za-z]/g, ''))) {
      report.error('儀器角度單位是「' + meta.angleUnits + '」，重測系統需要「度分秒(DDDMMSS)」，請在儀器上改設定後重新下載');
    }
    if (meta.distUnits && !/met/i.test(meta.distUnits)) {
      report.error('儀器距離單位是「' + meta.distUnits + '」，重測系統需要「公尺」');
    }
    return { sessions: sessions, freeStations: freeStations, meta: meta };
  }

  function rawToMac(text, filename, opts) {
    opts = opts || {};
    var codeMode = opts.codeMode || 'pad2';
    var sep = opts.sep === 'tab' ? '\t' : ' ';
    var report = new Report();
    var parsed = parseNikonRaw(text, report);
    var sessions = parsed.sessions;

    if (!sessions.length) {
      report.error('找不到任何測站（ST）資料，這可能不是 Nikon RAW 檔');
    }

    var out = ['LS'];
    var outZero = ['LS'];
    var preview = [];
    var obsCount = 0;
    var nonZero = 0;
    var cannotZero = 0;

    sessions.forEach(function (s, si) {
      out.push([s.station, s.back].join(sep));
      outZero.push([s.station, s.back].join(sep));

      // 後視歸零參考：優先用 F1 後視觀測，其次用照準後視點的 SS 觀測
      var ref = s.backObs;
      if (!ref) {
        for (var i = 0; i < s.obs.length; i++) {
          if (s.obs[i].pt === s.back) { ref = { ha: s.obs[i].ha, line: s.obs[i].line, src: 'SS' }; break; }
        }
      }
      var refSec = ref ? dmsToSec(ref.ha) : null;
      var needZero = refSec !== null && Math.abs(refSec) > 1e-9;
      if (needZero) nonZero++;
      if (!ref && s.obs.length) {
        cannotZero++;
        report.info('測站 ' + s.station + ' 沒有照準後視點 ' + s.back + ' 的觀測，無法檢查後視是否歸零', s.line);
      }
      if (!s.obs.length) report.warn('測站 ' + s.station + ' 沒有任何觀測資料', s.line);

      s.obs.forEach(function (o) {
        var name = formatPointName(o.pt, o.code, codeMode, report, o.line);
        out.push([name, o.ha, o.va, o.sd].join(sep));
        var ha0 = o.ha;
        var haSec = dmsToSec(o.ha);
        if (needZero && haSec !== null) {
          ha0 = secToDms(haSec - refSec, Math.max(dmsSecDecimals(o.ha), dmsSecDecimals(ref.ha)));
        }
        outZero.push([name, ha0, o.va, o.sd].join(sep));
        preview.push({ station: s.station, back: s.back, name: name, ha: o.ha, ha0: ha0, va: o.va, sd: o.sd, line: o.line });
        obsCount++;
      });
      void si;
    });

    // 重複點號檢查
    var seen = {};
    preview.forEach(function (p) {
      if (seen[p.name] && p.name !== p.back) {
        report.info('點號 ' + p.name + ' 出現多次（第 ' + seen[p.name] + ' 行與第 ' + p.line + ' 行），請確認', p.line);
      } else if (!seen[p.name]) seen[p.name] = p.line;
    });

    if (parsed.freeStations.length) {
      report.warn('有 ' + parsed.freeStations.length + ' 個自由測站，請自行新增至重測系統（或使用下方的自由測站 .cnt 檔）');
    }

    var base = opts.outName || baseName(filename);
    var files = [];
    if (sessions.length) {
      files.push({ name: base + '.mac', content: joinLines(out), main: true,
        desc: '原始角度（與儀器紀錄相同）' });
      if (nonZero > 0 || opts.alwaysZero) {
        files.push({ name: base + '_Zero.mac', content: joinLines(outZero),
          desc: '後視歸零版：每站後視方向當作 0°00\'00"（有 ' + nonZero + ' 站後視不為 0）', recommended: nonZero > 0 });
      }
    }
    if (parsed.freeStations.length) {
      files.push({
        name: base + '_自由測站.cnt',
        content: joinLines(parsed.freeStations.map(function (f) { return [f.name, f.n, f.e].join(sep); })),
        desc: '自由測站坐標（點號 N E）'
      });
    }

    return {
      kind: 'raw2mac',
      files: files,
      report: report.items,
      stats: {
        stations: sessions.length,
        observations: obsCount,
        nonZeroStations: nonZero,
        cannotCheckZero: cannotZero,
        freeStations: parsed.freeStations.length
      },
      preview: preview,
      freeStations: parsed.freeStations,
      meta: parsed.meta
    };
  }

  // ═════════════ 2. GPS/VRS CSV → CNT + MAC ═════════════

  function splitCsvLine(line) {
    if (line.indexOf(',') >= 0) return line.split(',').map(stripQuotes);
    if (line.indexOf('\t') >= 0) return line.split('\t').map(stripQuotes);
    return line.trim().split(/\s+/).map(stripQuotes);
  }

  /** 讀 GPS 控制器輸出的 CSV（預設欄位：點名,N,E,CD碼）。 */
  function parseGpsCsv(text, opts, report) {
    var nameCol = (opts.nameCol || 1) - 1;
    var nCol = (opts.nCol || 2) - 1;
    var eCol = (opts.eCol || 3) - 1;
    var codeCol = opts.codeCol === 0 ? -1 : ((opts.codeCol || 4) - 1);
    var pts = [];
    var maxCols = 0;
    splitLines(text).forEach(function (raw, idx) {
      var lineNo = idx + 1;
      if (!raw.trim()) return;
      var f = splitCsvLine(raw);
      maxCols = Math.max(maxCols, f.length);
      var name = f[nameCol] || '';
      var n = f[nCol] || '';
      var e = f[eCol] || '';
      if (!isNum(n) || !isNum(e)) {
        if (pts.length === 0) report.info('第 ' + lineNo + ' 行不是坐標資料（可能是標題列），已略過', lineNo);
        else report.warn('第 ' + lineNo + ' 行的 N/E 不是數字，已略過：' + raw.trim(), lineNo);
        return;
      }
      if (!name) { report.error('第 ' + lineNo + ' 行沒有點名，已略過', lineNo); return; }
      pts.push({ name: name, n: n.trim(), e: e.trim(), N: parseFloat(n), E: parseFloat(e),
        code: codeCol >= 0 ? (f[codeCol] || '') : '', line: lineNo, cols: f });
    });
    return { points: pts, maxCols: maxCols };
  }

  function csvToCntMac(text, filename, opts) {
    opts = opts || {};
    var codeMode = opts.codeMode || 'pad2';
    var angleDec = opts.angleDecimals == null ? 0 : opts.angleDecimals;
    var distDec = opts.distDecimals == null ? 3 : opts.distDecimals;
    var sep = opts.sep === 'tab' ? '\t' : ' ';
    var report = new Report();
    var parsed = parseGpsCsv(text, opts, report);
    var pts = parsed.points;
    var base = opts.outName || baseName(filename);

    var result = { kind: 'csv2cntmac', files: [], report: report.items, preview: [],
      stats: { points: pts.length, maxErrMm: null }, maxCols: parsed.maxCols };

    if (pts.length < 2) {
      report.error('至少需要 2 個點才能轉換（目前 ' + pts.length + ' 個）');
      return result;
    }

    pts.forEach(function (p) {
      if (p.name === STATION_ID || p.name === BACKSIGHT_ID) {
        report.error('點名 ' + p.name + ' 與虛擬測站/後視點號衝突，請先改名', p.line);
      }
    });

    var st = pts[0];
    // 後視點：第一個與測站不重合的點（舊版固定用第 2 點，重合時會整批錯誤）
    var bs = null;
    for (var i = 1; i < pts.length; i++) {
      if (Math.hypot(pts[i].N - st.N, pts[i].E - st.E) > 0.001) { bs = pts[i]; break; }
    }
    if (!bs) {
      report.error('所有點的坐標都與第 1 點相同，無法建立後視方向');
      return result;
    }
    if (bs !== pts[1]) {
      report.warn('第 2 點與第 1 點坐標重合，改用「' + bs.name + '」當後視點', bs.line);
    }

    var azBs = azimuthSec(bs.N - st.N, bs.E - st.E);
    var azBsRad = azBs / 3600 * Math.PI / 180;
    var mac = ['LS', STATION_ID + sep + BACKSIGHT_ID];
    var maxErr = 0;
    var seen = {};

    pts.forEach(function (p) {
      var dN = p.N - st.N, dE = p.E - st.E;
      var dist = Math.hypot(dN, dE);
      var angSec = dist < 1e-9 ? 0 : azimuthSec(dN, dE) - azBs;
      var angStr = secToDms(angSec, angleDec);
      var distStr = dist.toFixed(distDec);
      var name = formatPointName(p.name, p.code, codeMode, report, p.line);
      if (seen[name]) report.warn('點號 ' + name + ' 重複（第 ' + seen[name] + ' 行與第 ' + p.line + ' 行）', p.line);
      else seen[name] = p.line;
      mac.push([name, angStr, distStr].join(sep));

      // 反算檢核：用寫進檔案的（已四捨五入的）角度、距離推回坐標
      var a = azBsRad + dmsToSec(angStr) / 3600 * Math.PI / 180;
      var d = parseFloat(distStr);
      var errMm = Math.hypot(st.N + d * Math.cos(a) - p.N, st.E + d * Math.sin(a) - p.E) * 1000;
      if (errMm > maxErr) maxErr = errMm;
      result.preview.push({ name: name, n: p.n, e: p.e, ang: angStr, dist: distStr, errMm: errMm, line: p.line,
        role: p === st ? 'station' : (p === bs ? 'backsight' : '') });
    });

    var cnt = [
      [STATION_ID, st.n, st.e].join(sep),
      [BACKSIGHT_ID, bs.n, bs.e].join(sep)
    ];

    result.stats.maxErrMm = maxErr;
    result.stats.station = st.name;
    result.stats.backsight = bs.name;
    if (maxErr > 2) {
      report.warn('角度四捨五入造成的最大坐標誤差為 ' + maxErr.toFixed(1) + ' mm，建議在「進階設定」把角度秒數改成 1 位小數');
    }
    result.files.push({ name: base + '.cnt', content: joinLines(cnt), main: true,
      desc: '虛擬測站 99999（= ' + st.name + '）與後視點 99998（= ' + bs.name + '）坐標' });
    result.files.push({ name: base + '.mac', content: joinLines(mac), main: true,
      desc: pts.length + ' 點的角度與水平距離' });
    return result;
  }

  // ═════════════ 3. 重測系統 L02/L14/L20 → 全站儀 / GPS 控制器 CSV ═════════════

  var L_TYPES = {
    L02: '控制點',
    L14: '界址點',
    L20: '補點'
  };

  var DEVICE_PRESETS = {
    ts: { label: '全站儀', order: ['L14', 'L20', 'L02'], ext: 'CSV' },   // 同 TS01.xls
    gps: { label: 'GPS 控制器', order: ['L02', 'L14', 'L20'], ext: 'csv' } // 同 TrimblePointInputV3.jar
  };

  function normalizeName(name, stripCode) {
    if (stripCode) {
      var m = /^(\d+)\.\d+$/.exec(name);
      if (m) return m[1];
    }
    if (/^\d+\.0+$/.test(name)) return name.replace(/\.0+$/, '');
    return name;
  }

  /**
   * 從 L 檔一行中找出所有「點號 坐標 坐標」三元組。
   * 一行可有多組（每行 3 點的格式），標題、頁碼等文字會自動跳過。
   */
  function extractTriples(line) {
    var t = line.trim().split(/[\s,]+/).filter(Boolean);
    var res = [];
    var i = 0;
    while (i + 2 < t.length) {
      if (/^[A-Za-z0-9_\-.]+$/.test(t[i]) && isNum(t[i + 1]) && isNum(t[i + 2]) &&
          t[i + 1].indexOf('.') >= 0 && t[i + 2].indexOf('.') >= 0) {
        res.push([t[i], t[i + 1], t[i + 2]]);
        i += 3;
      } else {
        i++;
      }
    }
    return res;
  }

  function lToCsv(inputs, opts) {
    opts = opts || {};
    var preset = DEVICE_PRESETS[opts.device] || DEVICE_PRESETS.ts;
    var report = new Report();
    var order = preset.order;
    var sorted = inputs.slice().sort(function (a, b) {
      var ia = order.indexOf(extName(a.name)), ib = order.indexOf(extName(b.name));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });

    var points = [];
    var perFile = [];
    var byName = {};
    var dupSame = 0;

    sorted.forEach(function (inp) {
      var ext = extName(inp.name);
      var label = L_TYPES[ext] || '其他';
      if (!L_TYPES[ext]) report.warn('「' + inp.name + '」不是 L02/L14/L20 檔，仍嘗試讀取');
      var count = 0;
      var skipped = 0;
      splitLines(inp.text).forEach(function (raw, idx) {
        if (!raw.trim()) return;
        var triples = extractTriples(raw);
        if (!triples.length) { skipped++; return; }
        triples.forEach(function (tr) {
          var name = normalizeName(tr[0], opts.stripCode);
          var p = { name: name, y: tr[1], x: tr[2], src: inp.name, type: label, line: idx + 1 };
          var prev = byName[name];
          if (prev) {
            if (prev.y === p.y && prev.x === p.x) {
              dupSame++;
              return; // 完全相同的重複點，只留第一筆
            }
            report.warn('點號 ' + name + ' 在「' + prev.src + '」與「' + inp.name + '」坐標不同，兩筆都保留，請確認', idx + 1);
          } else {
            byName[name] = p;
          }
          points.push(p);
          count++;
        });
      });
      perFile.push({ name: inp.name, type: label, count: count, skipped: skipped });
      if (count === 0) report.error('「' + inp.name + '」裡找不到任何點位坐標');
      else if (skipped) report.info('「' + inp.name + '」有 ' + skipped + ' 行不是坐標（標題或空白），已略過');
    });

    if (dupSame) report.info('有 ' + dupSame + ' 筆在不同檔案中完全相同的重複點，已自動只保留一筆');

    var lines = points.map(function (p) {
      return opts.swapXY ? [p.name, p.x, p.y].join(',') : [p.name, p.y, p.x].join(',');
    });

    var base = opts.outName || (sorted.length ? baseName(sorted[0].name) : '未命名');
    var files = [];
    if (points.length) {
      files.push({ name: base + '.' + preset.ext, content: joinLines(lines), main: true,
        desc: '給' + preset.label + '匯入：點號,' + (opts.swapXY ? '第2坐標,第1坐標' : 'Y,X') + '（共 ' + points.length + ' 點）' });
    }
    return {
      kind: 'l2csv',
      device: opts.device || 'ts',
      files: files,
      report: report.items,
      preview: points,
      perFile: perFile,
      stats: { points: points.length, files: sorted.length }
    };
  }

  // ───────────────────────── 自動判斷 ─────────────────────────

  /** 依副檔名與內容猜測要用哪一種轉換。 */
  function detectKind(filename, text) {
    var ext = extName(filename);
    if (ext === 'RAW') return 'raw2mac';
    if (L_TYPES[ext]) return 'l2csv';
    var head = splitLines(text || '').slice(0, 40).join('\n');
    if (/^(ST|SS|F1),/m.test(head)) return 'raw2mac';
    if (ext === 'CSV' || ext === 'TXT' || ext === 'ASC') return 'csv2cntmac';
    return null;
  }

  return {
    rawToMac: rawToMac,
    csvToCntMac: csvToCntMac,
    lToCsv: lToCsv,
    detectKind: detectKind,
    // 以下為工具函式（測試用）
    dmsToSec: dmsToSec,
    secToDms: secToDms,
    azimuthSec: azimuthSec,
    formatPointName: formatPointName,
    extractTriples: extractTriples,
    normalizeName: normalizeName,
    baseName: baseName,
    extName: extName,
    DEVICE_PRESETS: DEVICE_PRESETS
  };
});
