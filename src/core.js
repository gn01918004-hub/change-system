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
    var known = {}; // 檔案內已知坐標（UP/MP/CC 紀錄）

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
          cur.backObs = { ha: f[4] || '', sd: f[3] || '', va: f[5] || '', line: lineNo, src: type };
        }
        return;
      }
      if (type === 'UP' || type === 'MP' || type === 'CC') {
        // UP,點號,編碼,N,E,Z,...
        if (f[1] && isNum(f[3] || '') && isNum(f[4] || '')) known[f[1]] = { N: parseFloat(f[3]), E: parseFloat(f[4]) };
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
    return { sessions: sessions, freeStations: freeStations, meta: meta, known: known };
  }

  /** 水平距離 = 斜距 × sin(天頂角) */
  function horizDist(sd, va) {
    var v = dmsToSec(va);
    var d = parseFloat(sd);
    if (v === null || !isFinite(d)) return null;
    return d * Math.sin(v / 3600 * Math.PI / 180);
  }

  /**
   * 用檔案裡的已知坐標（UP 等）推算各觀測點的大略位置，給縮圖用；
   * 同時做後視檢核（觀測距離 vs 坐標反算距離）。
   */
  function computeRawPlot(parsed, report) {
    var known = {};
    Object.keys(parsed.known).forEach(function (k) { known[k] = parsed.known[k]; });
    var pts = [];
    var rays = [];
    var missing = 0;
    var addPt = function (name, N, E, kind) { pts.push({ name: name, N: N, E: E, kind: kind }); };
    Object.keys(parsed.known).forEach(function (k) { addPt(k, known[k].N, known[k].E, 'known'); });

    parsed.sessions.forEach(function (s) {
      var S = known[s.station], B = known[s.back];
      if (!S || !B) { if (s.obs.length) missing++; return; }
      var azB = Math.atan2(B.E - S.E, B.N - S.N);
      var ref = s.backObs ? dmsToSec(s.backObs.ha) : null;
      if (ref === null) {
        for (var i = 0; i < s.obs.length; i++) if (s.obs[i].pt === s.back) { ref = dmsToSec(s.obs[i].ha); break; }
      }
      if (ref === null) ref = 0;
      addPt(s.station, S.N, S.E, 'station');

      // 後視檢核
      if (s.backObs && s.backObs.sd) {
        var hd = horizDist(s.backObs.sd, s.backObs.va);
        var dc = Math.hypot(B.N - S.N, B.E - S.E);
        if (hd !== null) {
          var diff = (hd - dc) * 1000;
          var msg = '測站 ' + s.station + ' 後視 ' + s.back + ' 檢核：觀測水平距離 ' + hd.toFixed(3) + ' m，坐標反算 ' + dc.toFixed(3) + ' m，差 ' + diff.toFixed(0) + ' mm';
          if (Math.abs(diff) > 50) report.warn(msg + '，差距偏大，請確認測站或後視點是否正確', s.backObs.line);
          else report.info(msg, s.backObs.line);
        }
      }

      s.obs.forEach(function (o) {
        var hd2 = horizDist(o.sd, o.va), ha = dmsToSec(o.ha);
        if (hd2 === null || ha === null) return;
        var az = azB + (ha - ref) / 3600 * Math.PI / 180;
        var P = { N: S.N + hd2 * Math.cos(az), E: S.E + hd2 * Math.sin(az) };
        addPt(o.pt, P.N, P.E, 'obs');
        rays.push({ from: s.station, N1: S.N, E1: S.E, N2: P.N, E2: P.E });
        if (!known[o.pt]) known[o.pt] = P; // 例如先觀測、後來當測站的點（QT60-2）
      });
    });
    var focus = {};
    parsed.sessions.forEach(function (s) { focus[s.station] = 1; focus[s.back] = 1; });
    return { points: pts, rays: rays, missingStations: missing, focus: focus };
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

    var plot = computeRawPlot(parsed, report);

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
      plot: plot,
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

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** 去掉多餘的 0（2707967.750 → 2707967.75），與 Excel 存出的 CSV 相同。 */
  function trimNum(s) {
    if (!isNum(s)) return s;
    var v = parseFloat(s);
    return String(Math.round(v * 1e6) / 1e6);
  }

  /**
   * 自動判斷 GPS CSV 的欄位：
   *   點名,N,E,編碼           （整理後的格式）
   *   點名,N,E,高程,編碼      （控制器直接輸出的格式）
   *   點名,N,E,高程           （沒有編碼）
   * opts.codeCol：'auto'（預設）、0 = 沒有編碼、4/5/... = 指定欄位。
   */
  function detectGpsColumns(rows, opts) {
    var cols = { name: 0, n: 1, e: 2, h: -1, code: -1, auto: true };
    var manual = opts.codeCol;
    if (manual === 0) { cols.auto = false; return cols; }
    if (typeof manual === 'number' && manual >= 4) {
      cols.auto = false;
      cols.code = manual - 1;
      if (manual >= 5) cols.h = 3;
      return cols;
    }
    var data = rows.filter(function (f) { return isNum(f[1] || '') && isNum(f[2] || ''); });
    var vals = function (i) { return data.map(function (f) { return (f[i] || '').trim(); }).filter(Boolean); };
    var intLike = function (v) { return /^\d{1,4}$/.test(v); };
    var decLike = function (v) { return /^-?\d+\.\d+$/.test(v); };
    var c4 = vals(3), c5 = vals(4);
    var mostly = function (a, fn) { return a.length && a.filter(fn).length >= a.length * 0.8; };
    if (c5.length && mostly(c5, intLike)) {
      cols.code = 4;
      if (mostly(c4, decLike) || !c4.length) cols.h = 3;
    } else if (mostly(c4, intLike)) {
      cols.code = 3;
    } else if (mostly(c4, decLike)) {
      cols.h = 3;
    }
    return cols;
  }

  var FLAG_TEXT = {
    junk: '雜點：坐標是 0 或不是數字',
    check: '現場核對點（沒有編碼）',
    far: '離其他點太遠',
    dup: '點名重複',
    nocode: '沒有編碼',
    badcode: '編碼不是數字',
    samexy: '與其他點坐標相同'
  };
  // 這些狀況預設剔除，其他只提醒
  var EXCLUDE_FLAGS = { junk: 1, check: 1, far: 1, dup: 1 };

  /** 讀 GPS CSV 並逐點檢查，標出有疑慮的點與預設是否轉換。 */
  function analyzeGpsCsv(text, opts, report) {
    var rows = [];
    splitLines(text).forEach(function (raw, idx) {
      if (!raw.trim()) return;
      var f = splitCsvLine(raw);
      f.line = idx + 1;
      f.raw = raw.trim();
      rows.push(f);
    });
    // 第一行若 N/E 不是數字，當成標題列
    if (rows.length && !(isNum(rows[0][1] || '') && isNum(rows[0][2] || '')) && !/^\d+$/.test(rows[0][0] || '')) {
      report.info('第 ' + rows[0].line + ' 行是標題列，已略過', rows[0].line);
      rows.shift();
    }
    var cols = detectGpsColumns(rows, opts);
    var maxCols = rows.reduce(function (m, f) { return Math.max(m, f.length); }, 0);

    var pts = rows.map(function (f) {
      var p = {
        line: f.line, raw: f.raw,
        name: (f[cols.name] || '').trim(),
        n: (f[cols.n] || '').trim(),
        e: (f[cols.e] || '').trim(),
        h: cols.h >= 0 ? (f[cols.h] || '').trim() : '',
        code: cols.code >= 0 ? (f[cols.code] || '').trim() : '',
        flags: [], note: {}
      };
      p.N = parseFloat(p.n); p.E = parseFloat(p.e); p.H = parseFloat(p.h);
      return p;
    });

    var hasAnyCode = pts.some(function (p) { return p.code !== ''; });
    var hasHeights = pts.some(function (p) { return isFinite(p.H) && p.H !== 0; });

    pts.forEach(function (p) {
      if (!p.name || !isNum(p.n) || !isNum(p.e) || p.N === 0 || p.E === 0) {
        p.flags.push('junk');
      } else if (hasAnyCode && p.code === '') {
        if (!/^\d+$/.test(p.name) || (hasHeights && (!isFinite(p.H) || p.H === 0))) p.flags.push('check');
        else p.flags.push('nocode');
      }
      if (p.code !== '' && !/^\d+(\.0*)?$/.test(p.code)) p.flags.push('badcode');
    });

    var cand = pts.filter(function (p) { return !p.flags.some(function (f) { return EXCLUDE_FLAGS[f]; }); });

    // 離群點：與中位數中心的距離超過「一般距離的 10 倍且至少 200 m」
    if (cand.length >= 3) {
      var cN = median(cand.map(function (p) { return p.N; }));
      var cE = median(cand.map(function (p) { return p.E; }));
      var ds = cand.map(function (p) { return Math.hypot(p.N - cN, p.E - cE); });
      var thr = Math.max(200, 10 * median(ds));
      cand.forEach(function (p, i) {
        if (ds[i] > thr) { p.flags.push('far'); p.note.far = Math.round(ds[i]); }
      });
      cand = cand.filter(function (p) { return p.flags.indexOf('far') < 0; });
    }

    // 點名重複：保留第一筆
    var seenName = {};
    cand.forEach(function (p) {
      if (seenName[p.name]) { p.flags.push('dup'); p.note.dup = seenName[p.name].line; }
      else seenName[p.name] = p;
    });
    // 坐標相同但點名不同
    var seenXY = {};
    cand.forEach(function (p) {
      if (p.flags.indexOf('dup') >= 0) return;
      var k = Math.round(p.N * 1000) + ',' + Math.round(p.E * 1000);
      if (seenXY[k]) { p.flags.push('samexy'); p.note.samexy = seenXY[k].name; }
      else seenXY[k] = p;
    });

    var decisions = opts.decisions || {};
    pts.forEach(function (p) {
      p.auto = !p.flags.some(function (f) { return EXCLUDE_FLAGS[f]; });
      p.include = Object.prototype.hasOwnProperty.call(decisions, p.line) ? !!decisions[p.line] : p.auto;
      p.reasons = p.flags.map(function (f) {
        var t = FLAG_TEXT[f];
        if (f === 'far') t += '（約 ' + p.note.far + ' m）';
        if (f === 'dup') t += '（與第 ' + p.note.dup + ' 行相同）';
        if (f === 'samexy') t += '（' + p.note.samexy + '）';
        return t;
      });
    });

    return { points: pts, cols: cols, maxCols: maxCols };
  }

  function csvToCntMac(text, filename, opts) {
    opts = opts || {};
    var codeMode = opts.codeMode || 'pad2';
    var angleDec = opts.angleDecimals == null ? 0 : opts.angleDecimals;
    var distDec = opts.distDecimals == null ? 3 : opts.distDecimals;
    var sep = opts.sep === 'tab' ? '\t' : ' ';
    var report = new Report();
    var an = analyzeGpsCsv(text, opts, report);
    var all = an.points;
    var pts = all.filter(function (p) { return p.include; });
    var base = opts.outName || baseName(filename);

    var excluded = all.filter(function (p) { return !p.include; });
    var flagged = all.filter(function (p) { return p.flags.length; });
    var result = { kind: 'csv2cntmac', files: [], report: report.items, preview: [], points: all,
      cols: an.cols, maxCols: an.maxCols,
      stats: { points: pts.length, total: all.length, excluded: excluded.length, flagged: flagged.length, maxErrMm: null } };

    if (excluded.length) {
      var byReason = {};
      excluded.forEach(function (p) {
        var k = p.flags.filter(function (f) { return EXCLUDE_FLAGS[f]; }).map(function (f) { return FLAG_TEXT[f]; })[0] || '手動剔除';
        byReason[k] = (byReason[k] || 0) + 1;
      });
      report.info('剔除 ' + excluded.length + ' 點不轉換：' + Object.keys(byReason).map(function (k) { return k + ' ' + byReason[k] + ' 點'; }).join('、') + '（可在「點位檢查」改）');
    }
    all.forEach(function (p) {
      if (p.include && p.flags.length) report.warn('點 ' + (p.name || '(無名)') + '：' + p.reasons.join('、') + '，仍會轉換，請確認', p.line);
    });

    if (pts.length < 2) {
      report.error('至少需要 2 個點才能轉換（目前勾選 ' + pts.length + ' 個）');
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
    var clean = [];
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
      clean.push([p.name, trimNum(p.n), trimNum(p.e)].concat(an.cols.code >= 0 ? [p.code] : []).join(','));

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
    var needClean = excluded.length || an.cols.h >= 0 || an.cols.code > 3;
    if (needClean) {
      result.files.push({ name: base + '_整理.csv', content: joinLines(clean),
        desc: '整理後的 CSV（點名,N,E' + (an.cols.code >= 0 ? ',編碼' : '') + '），已移除高程欄與剔除的點，可留存備查' });
    }
    return result;
  }

  // ═════════════ 3. 重測系統 L02/L14/L20 → 全站儀 / GPS 控制器 CSV ═════════════

  var L_TYPES = {
    L02: '控制點',
    L14: '界址點/參考點',
    L20: '補點'
  };

  // 全站儀與 GPS 控制器吃的格式相同（點號,Y,X），只輸出一種檔。
  // 點位順序：控制點 → 界址點/參考點 → 補點（現場先找控制點）。
  var L_ORDER = ['L02', 'L14', 'L20'];

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
    var report = new Report();
    var order = L_ORDER;
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
      var ext = opts.ext === 'txt' ? 'txt' : 'csv';
      files.push({ name: base + '.' + ext, content: joinLines(lines), main: true,
        desc: '全站儀、GPS 控制器都能匯入：點號,' + (opts.swapXY ? '第2坐標,第1坐標' : 'Y,X') + '（共 ' + points.length + ' 點）' });
    }
    return {
      kind: 'l2csv',
      files: files,
      report: report.items,
      preview: points,
      perFile: perFile,
      stats: { points: points.length, files: sorted.length }
    };
  }

  // ───────────────────────── 資料夾掃描 ─────────────────────────

  /** 同一個案件的 L02/L14/L20 視為一組：同資料夾、同主檔名（例如 KC0390.L02 + KC0390.L14）。 */
  function lGroupKey(path) {
    var p = String(path || '').replace(/\\/g, '/');
    var dir = p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/') + 1) : '';
    return (dir + baseName(p)).toUpperCase();
  }

  /**
   * 把資料夾裡的檔案依轉換種類分組，給使用者勾選。
   * list：[{ name, path }]，回傳 { l2csv:[...], raw2mac:[...], csv2cntmac:[...] }，
   * 每一項 { key, label, dir, files:[原物件...] }。
   */
  function groupFolderFiles(list) {
    var out = { l2csv: [], raw2mac: [], csv2cntmac: [] };
    var lmap = {};
    list.forEach(function (f) {
      var path = f.path || f.name;
      var ext = extName(f.name);
      var dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
      if (L_TYPES[ext]) {
        var k = lGroupKey(path);
        if (!lmap[k]) {
          lmap[k] = { key: k, label: baseName(f.name), dir: dir, files: [], exts: [] };
          out.l2csv.push(lmap[k]);
        }
        lmap[k].files.push(f);
        lmap[k].exts.push(ext);
      } else if (ext === 'RAW') {
        out.raw2mac.push({ key: path, label: f.name, dir: dir, files: [f] });
      } else if (ext === 'CSV' || ext === 'ASC') {
        out.csv2cntmac.push({ key: path, label: f.name, dir: dir, files: [f] });
      }
    });
    var byLabel = function (a, b) { return (a.dir + '/' + a.label).localeCompare(b.dir + '/' + b.label, 'zh-Hant'); };
    out.l2csv.forEach(function (g) {
      var order = ['L02', 'L14', 'L20'];
      g.exts.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
    });
    out.l2csv.sort(byLabel); out.raw2mac.sort(byLabel); out.csv2cntmac.sort(byLabel);
    return out;
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
    groupFolderFiles: groupFolderFiles,
    lGroupKey: lGroupKey,
    L_TYPES: L_TYPES,
    // 以下為工具函式（測試用）
    dmsToSec: dmsToSec,
    secToDms: secToDms,
    azimuthSec: azimuthSec,
    formatPointName: formatPointName,
    extractTriples: extractTriples,
    normalizeName: normalizeName,
    baseName: baseName,
    extName: extName,
    L_ORDER: L_ORDER
  };
});
