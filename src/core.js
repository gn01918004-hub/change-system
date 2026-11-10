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
  function computeRawPlot(parsed, report, extraKnown) {
    var known = {};
    // 已知坐標：RAW 檔裡的 UP 紀錄優先，再用重測系統檔（D14/D20）
    if (extraKnown) Object.keys(extraKnown).forEach(function (k) { known[k] = extraKnown[k]; });
    Object.keys(parsed.known).forEach(function (k) { known[k] = parsed.known[k]; });
    var before = {};
    Object.keys(known).forEach(function (k) { before[k] = extraKnown && extraKnown[k] ? 'dbf' : 'up'; });
    var obsOut = [];
    var pts = [];
    var rays = [];
    var missing = 0;
    var addPt = function (name, N, E, kind) { pts.push({ name: name, N: N, E: E, kind: kind }); };
    Object.keys(parsed.known).forEach(function (k) { addPt(k, known[k].N, known[k].E, 'known'); });

    parsed.sessions.forEach(function (s) {
      if ((!known[s.station] || !known[s.back]) && s.obs.length) {
        report.warn('測站 ' + s.station + '（後視 ' + s.back + '）找不到已知坐標，這站的點無法算出坐標' +
          (!known[s.station] ? '：缺測站 ' + s.station : '') + (!known[s.back] ? '：缺後視 ' + s.back : ''), s.line);
      }
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
        // 數字點號要連編碼一起比（5 號界址點 5.00 和 5 號參考點 5.30 是不同點）
        var codeOk = /^\d{1,2}$/.test(String(o.code || '').trim());
        var kf = /^\d+$/.test(o.pt) && codeOk ? before[o.pt + '.' + pad(parseInt(o.code, 10), 2)] : before[o.pt];
        obsOut.push({ pt: o.pt, code: o.code, N: P.N, E: P.E, line: o.line, station: s.station, wasKnown: !!kf, knownFrom: kf || '' });
        rays.push({ from: s.station, N1: S.N, E1: S.E, N2: P.N, E2: P.E });
        if (!known[o.pt]) known[o.pt] = P; // 例如先觀測、後來當測站的點（QT60-2）
      });
    });
    var focus = {};
    parsed.sessions.forEach(function (s) { focus[s.station] = 1; focus[s.back] = 1; });
    return { points: pts, rays: rays, missingStations: missing, focus: focus, obs: obsOut };
  }

  /** Excel「通用」格式的數字：去掉多餘的 0（208.3100 → 208.31、90.0000 → 90、9.040 → 9.04） */
  function excelNum(v) {
    if (!isNum(String(v))) return String(v);
    var n = parseFloat(v);
    return String(Math.round(n * 1e8) / 1e8);
  }

  /**
   * MAC 檔輸出。rows：{ k: 'LS' } | { k: 'st', v: [測站, 後視] } | { k: 'obs', v: [點號, …數值] }
   *   style 'excel'（預設）：和 Excel 轉檔工具存出來的一樣——Tab 分隔、數字去尾 0、數字點號後面多一個空白，
   *                         全站儀 7 欄（點號、空、水平角、空、天頂角、空、斜距），GPS 3 欄（點號、角度、距離）
   *   style 'space' / 'tab'：舊 jar 版，直接用空白或 Tab 隔開
   */
  function renderMac(rows, style, wide) {
    var ncol = wide ? 7 : 3;
    var tabs = function (n) { return new Array(n + 1).join('\t'); };
    if (style === 'space' || style === 'tab') {
      var sp = style === 'tab' ? '\t' : ' ';
      return joinLines(rows.map(function (r) { return r.k === 'LS' ? 'LS' : r.v.join(sp); }));
    }
    return joinLines(rows.map(function (r) {
      if (r.k === 'LS') return 'LS' + tabs(ncol - 1);
      if (r.k === 'st') return r.v[0] + '\t' + r.v[1] + tabs(ncol - 2);
      var name = /^\d+(\.\d+)?$/.test(r.v[0]) ? r.v[0] + ' ' : r.v[0];
      var nums = r.v.slice(1).map(excelNum);
      return wide ? name + '\t\t' + nums.join('\t\t') : [name].concat(nums).join('\t');
    }));
  }

  /** 改號：rename.byLine[原檔行] → 新點號；rename.byName[補點名稱] → 新名稱 */
  function renamed(rename, name, line) {
    if (!rename) return name;
    if (rename.byLine && rename.byLine[line]) return rename.byLine[line];
    if (rename.byName && rename.byName[name]) return rename.byName[name];
    return name;
  }

  function rawToMac(text, filename, opts) {
    opts = opts || {};
    var codeMode = opts.codeMode || 'pad2';
    var sep = opts.sep === 'tab' ? '\t' : ' ';
    var macStyle = opts.macStyle || 'excel';
    var report = new Report();
    var parsed = parseNikonRaw(text, report);
    var sessions = parsed.sessions;

    if (!sessions.length) {
      report.error('找不到任何測站（ST）資料，這可能不是 Nikon RAW 檔');
    }

    var out = [{ k: 'LS' }];
    var outZero = [{ k: 'LS' }];
    var preview = [];
    var obsCount = 0;
    var nonZero = 0;
    var cannotZero = 0;

    sessions.forEach(function (s, si) {
      var stName = renamed(opts.rename, s.station), bkName = renamed(opts.rename, s.back);
      out.push({ k: 'st', v: [stName, bkName] });
      outZero.push({ k: 'st', v: [stName, bkName] });

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
        var name = renamed(opts.rename, formatPointName(o.pt, o.code, codeMode, report, o.line), o.line);
        out.push({ k: 'obs', v: [name, o.ha, o.va, o.sd] });
        var ha0 = o.ha;
        var haSec = dmsToSec(o.ha);
        if (needZero && haSec !== null) {
          ha0 = secToDms(haSec - refSec, Math.max(dmsSecDecimals(o.ha), dmsSecDecimals(ref.ha)));
        }
        outZero.push({ k: 'obs', v: [name, ha0, o.va, o.sd] });
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

    var plot = computeRawPlot(parsed, report, opts.known);

    if (parsed.freeStations.length) {
      report.warn('有 ' + parsed.freeStations.length + ' 個自由測站，請自行新增至重測系統（或使用下方的自由測站 .cnt 檔）');
    }

    var base = opts.outName || baseName(filename);
    var files = [];
    if (sessions.length) {
      files.push({ name: base + '.mac', content: renderMac(out, macStyle, true), main: true,
        desc: '原始角度（與儀器紀錄相同）' });
      if (nonZero > 0 || opts.alwaysZero) {
        files.push({ name: base + '_Zero.mac', content: renderMac(outZero, macStyle, true),
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
    var decLike = function (v) { return /^-?\d+\.\d+$/.test(v); };
    // 編碼：短的英數字、沒有小數點（30、5、be73、q11 都算；高程 112.276 不算）
    var codeLike = function (v) { return /^[A-Za-z0-9]{1,6}$/.test(v) && !/^\d{5,}$/.test(v); };
    var c4 = vals(3), c5 = vals(4);
    var mostly = function (a, fn) { return a.length && a.filter(fn).length >= a.length * 0.8; };
    if (c5.length && mostly(c5, codeLike)) {
      cols.code = 4;
      if (mostly(c4, function (v) { return isNum(v); }) || !c4.length) cols.h = 3; // 高程可能寫成 0、0.000 或 97.082
    } else if (mostly(c4, codeLike)) {
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
    ask: '沒有編碼（有高程，可能是現場收的點）',
    badcode: '編碼不是 00～99',
    samexy: '與其他點坐標相同',
    digits: '坐標位數不對（Y 應為 7 位整數、X 應為 6 位整數）'
  };
  // 這些狀況預設剔除，其他只提醒
  var EXCLUDE_FLAGS = { junk: 1, check: 1, far: 1, dup: 1 };

  /** 編碼正規化成兩位數字（'5' → '05'、'7.0' → '07'）；不是 0～99 回傳 null。 */
  function normCode(c) {
    c = String(c == null ? '' : c).trim();
    if (!/^\d{1,2}(\.0*)?$/.test(c)) return null;
    return pad(parseInt(c, 10), 2);
  }

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

    // N、E 順序：台灣 TWD97 的 N（約 2,400,000～2,800,000）一定比 E（約 150,000～350,000）大，
    // 第 2 欄明顯比第 3 欄小時，判斷為「點名,E,N」並自動對調。opts.neOrder 可強制 'ne' 或 'en'。
    var neOrder = opts.neOrder || 'auto';
    var swapNE = neOrder === 'en';
    if (neOrder === 'auto') {
      var c2 = [], c3 = [];
      rows.forEach(function (f) {
        var a2 = parseFloat(f[1]), a3 = parseFloat(f[2]);
        if (isFinite(a2) && isFinite(a3) && a2 !== 0 && a3 !== 0) { c2.push(Math.abs(a2)); c3.push(Math.abs(a3)); }
      });
      // Y 整數 7 位、X 整數 6 位：第 2 欄大多是 6 位、第 3 欄大多是 7 位 → 檔案是「點名,E,N」
      var nSwap = 0;
      c2.forEach(function (v, i) { if (isXVal(v) && isYVal(c3[i])) nSwap++; });
      if (c2.length && nSwap >= c2.length * 0.5) swapNE = true;
      if (swapNE) report.warn('第 2 欄看起來是 E、第 3 欄是 N（N 應該比 E 大很多），已自動對調；若不對請到「進階設定」改');
    }
    if (swapNE) { cols.n = 2; cols.e = 1; }
    cols.swapNE = swapNE;

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
      } else if (/^q/i.test(p.code) && /^\d+$/.test(p.name)) {
        // 數字點號、編碼寫 Q 開頭：編碼就是補點名稱（13,…,q11 → Q11；只有字母時 12,…,QW → QW12）
        p.renamedFrom = p.name; p.origCode = p.code;
        // 編碼本身就是補點名稱（q11 → Q11）；編碼只有字母時才接上點號（QW → QW12）
        p.name = /\d/.test(p.code) ? p.code.toUpperCase() : p.code.toUpperCase() + p.name; p.code = '';
        p.supp = true;
      } else if (/^q/i.test(p.name) && isFinite(p.H) && p.H !== 0) {
        // Q 開頭又有高程（例如 QGGC32）：現場新測的補點；沒有高程的 Q 點（QW1）是系統內原有的點
        p.supp = true;
        p.origCode = p.code; p.code = '';
      } else if (hasAnyCode && p.code === '') {
        // 沒有編碼：有高程的可能是現場收的點（要問使用者編幾號），高程是 0 或點名不是數字的是現場核對點
        var hasH = isFinite(p.H) && p.H !== 0;
        if (hasHeights ? hasH : /^\d+$/.test(p.name)) p.flags.push('ask');
        else p.flags.push('check');
      }
      // 重測系統只吃 .00～.99：不是 1～2 位數字的編碼（例如 be73、q11、123）要換掉
      if (!p.supp && p.code !== '' && !/^\d{1,2}(\.0*)?$/.test(p.code)) p.flags.push('badcode');
      if (p.flags.indexOf('junk') < 0 && isNum(p.n) && isNum(p.e) && !(isYVal(p.n) && isXVal(p.e))) p.flags.push('digits');
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
    var overrides = opts.codeOverrides || {};
    var badTo = normCode(opts.badCodeTo == null ? '11' : opts.badCodeTo) || '11';
    var askAs = normCode(opts.noCodeAs);
    var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    pts.forEach(function (p) {
      p.auto = !p.flags.some(function (f) { return EXCLUDE_FLAGS[f]; });
      p.include = has(decisions, p.line) ? !!decisions[p.line] : p.auto;
      // 實際寫進重測系統的編碼：個別指定 > 不合格編碼換成 badTo > 現場點統一編號 > 原編碼
      p.codeFrom = '';
      if (has(overrides, p.line) && normCode(overrides[p.line]) !== null) { p.useCode = normCode(overrides[p.line]); p.codeFrom = 'manual'; }
      else if (p.flags.indexOf('badcode') >= 0) { p.useCode = badTo; p.codeFrom = 'bad'; }
      else if (p.flags.indexOf('ask') >= 0) { p.useCode = askAs; p.codeFrom = askAs === null ? 'pending' : 'ask'; }
      else if (p.supp) { p.useCode = ''; p.codeFrom = 'supp'; }
      else p.useCode = p.code === '' ? '' : normCode(p.code);
      p.reasons = p.flags.map(function (f) {
        var t = FLAG_TEXT[f];
        if (f === 'badcode') t = '編碼「' + p.code + '」不是 00～99，改成 ' + (p.codeFrom === 'manual' ? p.useCode : badTo);
        if (f === 'far') t += '（約 ' + p.note.far + ' m）';
        if (f === 'digits') t += '：Y ' + intDigits(p.n) + ' 位、X ' + intDigits(p.e) + ' 位';
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
    var pending = pts.filter(function (p) { return p.codeFrom === 'pending'; });
    result.stats.pending = pending.length;
    result.stats.recoded = pts.filter(function (p) { return p.codeFrom === 'bad' || p.codeFrom === 'ask' || p.codeFrom === 'manual' || p.renamedFrom; }).length;
    var supp = pts.filter(function (p) { return p.supp; });
    result.stats.supp = supp.length;
    if (supp.length) {
      report.info('有 ' + supp.length + ' 點是補點（Q 開頭、有高程）：' + supp.slice(0, 8).map(function (p) {
        return p.renamedFrom ? p.name + '（原點號 ' + p.renamedFrom + '、編碼 ' + p.origCode + '）' : p.name;
      }).join('、') + (supp.length > 8 ? '…' : '') + '；放入 D20 時會寫進補點檔');
    }
    if (pending.length) {
      report.warn('有 ' + pending.length + ' 點沒有編碼但有高程（' + pending.slice(0, 6).map(function (p) { return p.name; }).join('、') +
        (pending.length > 6 ? '…' : '') + '），可能是現場收的點，請在「點位檢查」決定要編成幾號（00～99）');
    }
    all.forEach(function (p) {
      if (!p.include || !p.flags.length) return;
      var soft = p.flags.filter(function (f) { return f !== 'badcode' && f !== 'ask'; });
      if (p.flags.indexOf('badcode') >= 0) {
        report.info('點 ' + p.name + '：原編碼「' + p.code + '」不是 00～99，改成 ' + p.useCode + '（見編碼對照表）', p.line);
      }
      if (p.codeFrom === 'ask' || (p.flags.indexOf('ask') >= 0 && p.codeFrom === 'manual')) {
        report.info('點 ' + p.name + '：沒有編碼，編成 ' + p.useCode + '（見編碼對照表）', p.line);
      }
      if (soft.length) {
        report.warn('點 ' + (p.name || '(無名)') + '：' + soft.map(function (f) { return p.reasons[p.flags.indexOf(f)]; }).join('、') + '，仍會轉換，請確認', p.line);
      }
    });

    // CNT＋MAC 用原本的規則：重測系統的 MAC 不能有 Q 點
    //   數字點號＋Q 編碼（13,…,q11）→ 原點號＋.11（13.11）
    //   Q 開頭的補點（QGGC32）→ 不放進 MAC，只能用「直接寫入 D20」
    var badToMac = normCode(opts.badCodeTo == null ? '11' : opts.badCodeTo) || '11';
    // CNT／MAC 不能有 Q 點：補點都要變成參考點的形式
    //   數字點號＋Q 編碼（13,…,q11）→ 原點號＋.11（13.11）
    //   Q 開頭的補點（QGGC32）→ 這批資料最大點號＋1，編碼 11（例如 42.11），列入對照表
    var qOnly = pts.filter(function (p) { return p.supp && !p.renamedFrom; });
    var maxNum = 0;
    pts.forEach(function (p) { var b = p.renamedFrom || p.name; if (/^\d+$/.test(b)) maxNum = Math.max(maxNum, parseInt(b, 10)); });
    qOnly.forEach(function (p) { p.autoNum = String(++maxNum); });
    if (qOnly.length) {
      report.info(qOnly.map(function (p) { return p.name + ' → ' + p.autoNum + '.' + badToMac; }).join('、') +
        '：Q 開頭的補點在 CNT 裡要用參考點的形式，已自動編號（見編碼對照表）；直接寫入 D20 時仍用原名稱');
    }
    // 輸出排序：參考點在前、補點在後（各自保持原檔順序）
    var macPts = pts.filter(function (p) { return !p.supp; }).concat(pts.filter(function (p) { return p.supp; }));
    macPts.forEach(function (p) {
      p.macBase = p.autoNum || p.renamedFrom || p.name;
      p.macCode = p.supp ? badToMac : (p.useCode || '');
    });
    result.stats.macPoints = macPts.length;

    if (macPts.length < 2) {
      report.error('CNT／MAC 至少需要 2 個點（目前 ' + macPts.length + ' 個）' + (qOnly.length ? '；Q 開頭的補點不能放進 MAC' : ''));
      return result;
    }

    macPts.forEach(function (p) {
      if (p.name === STATION_ID || p.name === BACKSIGHT_ID) {
        report.error('點名 ' + p.name + ' 與虛擬測站/後視點號衝突，請先改名', p.line);
      }
    });

    var st = macPts[0];
    // 後視點：第一個與測站不重合的點（舊版固定用第 2 點，重合時會整批錯誤）
    var bs = null;
    for (var i = 1; i < macPts.length; i++) {
      if (Math.hypot(macPts[i].N - st.N, macPts[i].E - st.E) > 0.001) { bs = macPts[i]; break; }
    }
    if (!bs) {
      report.error('所有點的坐標都與第 1 點相同，無法建立後視方向');
      return result;
    }
    if (bs !== macPts[1]) {
      report.warn('第 2 點與第 1 點坐標重合，改用「' + bs.name + '」當後視點', bs.line);
    }

    var azBs = azimuthSec(bs.N - st.N, bs.E - st.E);
    var azBsRad = azBs / 3600 * Math.PI / 180;
    var mac = [{ k: 'LS' }, { k: 'st', v: [STATION_ID, BACKSIGHT_ID] }];
    var cntLines = [];
    var clean = [];
    var maxErr = 0;
    var seen = {};

    macPts.forEach(function (p) {
      var dN = p.N - st.N, dE = p.E - st.E;
      var dist = Math.hypot(dN, dE);
      var angSec = dist < 1e-9 ? 0 : azimuthSec(dN, dE) - azBs;
      var angStr = secToDms(angSec, angleDec);
      var distStr = dist.toFixed(distDec);
      var name = renamed(opts.rename, formatPointName(p.macBase, p.macCode, codeMode, report, p.line), p.line);
      p.outName = name;
      if (seen[name]) report.warn('點號 ' + name + ' 重複（第 ' + seen[name] + ' 行與第 ' + p.line + ' 行）', p.line);
      else seen[name] = p.line;
      mac.push({ k: 'obs', v: [name, angStr, distStr] });
      cntLines.push([name, Number(p.N).toFixed(3), Number(p.E).toFixed(3)].join(','));
      clean.push([p.macBase, trimNum(p.n), trimNum(p.e)].concat(an.cols.code >= 0 ? [p.macCode === '' || p.macCode == null ? p.code : String(parseInt(p.macCode, 10))] : []).join(','));

      // 反算檢核：用寫進檔案的（已四捨五入的）角度、距離推回坐標
      var a = azBsRad + dmsToSec(angStr) / 3600 * Math.PI / 180;
      void sep;
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
    // 主要輸出：CNT（點號.編碼,Y,X），重測系統直接讀入
    result.files.push({ name: base + '.cnt', content: joinLines(cntLines), main: true,
      desc: '點號.編碼,Y,X（共 ' + cntLines.length + ' 點），重測系統讀入這個檔就好' });
    // 舊方式：虛擬測站 99999／99998 的 CNT＋MAC
    result.files.push({ name: base + '_虛擬測站.cnt', content: joinLines(cnt), old: true,
      desc: '舊方式：虛擬測站 99999（= ' + st.name + '）與後視點 99998（= ' + bs.name + '）坐標' });
    result.files.push({ name: base + '.mac', content: renderMac(mac, opts.macStyle || (opts.sep === 'tab' ? 'tab' : 'space'), false), old: true,
      desc: '舊方式：' + macPts.length + ' 點的角度與水平距離（搭配上面的虛擬測站 CNT）' });
    // 編碼對照表：每一個轉換的點，原本的點名/編碼 → 寫進重測系統的點號（Excel 可直接開，含 BOM）
    if (result.stats.recoded || pending.length || supp.length) {
      var WHY = { bad: '原編碼不是 00～99，自動改', ask: '沒有編碼，統一編號', manual: '手動指定', pending: '尚未決定編碼（暫用 00）', supp: '補點' };
      var rows = [['原點名', '原編碼', 'CNT 點號', '補點名稱（D20）', 'N', 'E', '高程', '說明'].join(',')];
      pts.forEach(function (p) {
        var cell = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
        rows.push([p.renamedFrom || p.name, p.origCode != null ? p.origCode : p.code, p.outName || '', p.supp ? p.name : '', p.n, p.e, p.h,
          p.renamedFrom ? '補點：名稱取自編碼 ' + p.origCode + '；CNT 用參考點形式 ' + (p.outName || '') :
            (p.supp ? '補點：CNT 自動編成參考點 ' + (p.outName || '') : (WHY[p.codeFrom] || ''))].map(cell).join(','));
      });
      result.files.push({ name: base + '_編碼對照表.csv', content: '\uFEFF' + joinLines(rows),
        desc: '原點名、原編碼對照轉換後的點號（' + result.stats.recoded + ' 點改過編碼），可用 Excel 開啟或列印' });
    }
    var needClean = excluded.length || an.cols.h >= 0 || an.cols.code > 3 || result.stats.recoded;
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
  // 輸出排序一律：界址點／參考點 → 補點 → 控制點
  var L_ORDER = ['L14', 'L20', 'L02'];

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

  /**
   * 判斷兩個坐標哪個是 Y（縱坐標、N）、哪個是 X（橫坐標、E）。
   * 台灣 TWD97 / TWD67：Y 約 2,4xx,xxx～2,8xx,xxx（常見 27… 開頭），X 約 1xx,xxx～3xx,xxx（常見 21… 開頭）。
   * 回傳 'yx'（a 是 Y）、'xy'（a 是 X）或 null（看不出來，例如假設坐標）。
   */
  function classifyYX(a, b) {
    if (isYVal(a) && isXVal(b)) return 'yx';
    if (isXVal(a) && isYVal(b)) return 'xy';
    return null;
  }
  /** 台灣坐標：Y（縱、N）整數部分一定 7 位數，X（橫、E）整數部分一定 6 位數 */
  function intDigits(v) {
    var n = Math.abs(parseFloat(v));
    return isFinite(n) && n >= 1 ? String(Math.floor(n)).length : 0;
  }
  function isYVal(v) { return intDigits(v) === 7; }
  function isXVal(v) { return intDigits(v) === 6; }

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
      var swapped = 0;
      var unknown = 0;
      splitLines(inp.text).forEach(function (raw, idx) {
        if (!raw.trim()) return;
        var triples = extractTriples(raw);
        if (!triples.length) { skipped++; return; }
        triples.forEach(function (tr) {
          var name = normalizeName(tr[0], opts.stripCode);
          // 依數值判斷哪個是 Y、哪個是 X（不管檔案裡誰在前）
          var kind = classifyYX(tr[1], tr[2]);
          if (kind === 'xy') swapped++;
          else if (!kind) unknown++;
          var p = kind === 'xy'
            ? { name: name, y: tr[2], x: tr[1], src: inp.name, type: label, line: idx + 1, swapped: true }
            : { name: name, y: tr[1], x: tr[2], src: inp.name, type: label, line: idx + 1 };
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
      perFile.push({ name: inp.name, type: label, count: count, skipped: skipped, swapped: swapped });
      if (swapped) {
        report.info('「' + inp.name + '」有 ' + swapped + ' 點的坐標是 X 在前（21… 在前、27… 在後），已依數值自動判斷：27… 是 Y、21… 是 X');
      }
      if (unknown) {
        report.warn('「' + inp.name + '」有 ' + unknown + ' 點看不出哪個是 Y、哪個是 X（Y 應為 7 位整數、X 應為 6 位整數），照檔案原本的順序當成 Y、X，請確認');
      }
      if (count === 0) report.error('「' + inp.name + '」裡找不到任何點位坐標');
      else if (skipped) report.info('「' + inp.name + '」有 ' + skipped + ' 行不是坐標（標題或空白），已略過');
    });

    if (dupSame) report.info('有 ' + dupSame + ' 筆在不同檔案中完全相同的重複點，已自動只保留一筆');

    // 輸出順序：'yx'（預設，點號,Y,X）或 'xy'（點號,X,Y）
    var outOrder = opts.order === 'xy' || (!opts.order && opts.swapXY) ? 'xy' : 'yx';
    var lines = points.map(function (p) {
      return outOrder === 'xy' ? [p.name, p.x, p.y].join(',') : [p.name, p.y, p.x].join(',');
    });

    var base = opts.outName || (sorted.length ? baseName(sorted[0].name) : '未命名');
    var files = [];
    if (points.length) files.push(writePoints(points, base, Object.assign({}, opts, { order: outOrder }), '共 ' + points.length + ' 點'));
    void lines;
    return {
      kind: 'l2csv',
      order: outOrder,
      files: files,
      report: report.items,
      preview: points,
      perFile: perFile,
      stats: { points: points.length, files: sorted.length }
    };
  }

  // ═════════════ 4. 複丈輸入檔（.COA/.BNP/.PAR/.CTL）→ 全站儀 / GPS 控制器 CSV ═════════════
  //
  // 取代「複丈輸入檔2SOKKIA v3.1」。資料夾裡沒有 L02/L14/L20 時使用。
  //   .COA  界址點坐標：點號(5) 空白 Y(16) X(15) 註記(1)
  //   .CTL  控制點：    點名(8) Y(11) X(10) 註記(1)
  //   .PAR  地號：      母號(4) 子號(4) 段(4) 面積(10) … 地目(1) … 中心 Y(9) X(8)
  //   .BNP  地號界址點：母號(4) 子號(4) 行序(3) 點數(4) 點號(6)×最多 11
  //   .D20  控制點屬性（dBASE），轉換用不到

  var COA_EXTS = ['COA', 'BNP', 'PAR', 'CTL', 'D20'];

  function parseCoa(text, report) {
    var map = {}, ids = [];
    splitLines(text).forEach(function (l, i) {
      if (i === 0 || !l.trim()) return;           // 第一行是標頭
      var m = /^\s*(\d+)\s+(\d+\.\d+?)(\d{6}\.\d+?)(\d)?\s*$/.exec(l);
      // 固定欄寬比較可靠：Y 16 字、X 15 字
      var id = l.slice(0, 5).trim(), y = l.slice(6, 22).trim(), x = l.slice(22, 37).trim();
      if (!/^\d+$/.test(id) || !isNum(y) || !isNum(x)) {
        if (m) { id = m[1]; y = m[2]; x = m[3]; }
        else { report.warn('.COA 第 ' + (i + 1) + ' 行看不懂，已略過：' + l.trim(), i + 1); return; }
      }
      if (!map[id]) ids.push(id);
      map[id] = { y: parseFloat(y).toFixed(3), x: parseFloat(x).toFixed(3) };
    });
    return { map: map, ids: ids };
  }

  function parseCtl(text, report) {
    var list = [];
    splitLines(text).forEach(function (l, i) {
      if (i === 0 || !l.trim()) return;
      var name = l.slice(0, 8).trim(), y = l.slice(8, 19).trim(), x = l.slice(19, 29).trim();
      if (!name || !isNum(y) || !isNum(x)) {
        var t = l.trim().split(/\s+/);
        if (t.length >= 3 && isNum(t[1]) && isNum(t[2])) { name = t[0]; y = t[1]; x = t[2]; }
        else { report.warn('.CTL 第 ' + (i + 1) + ' 行看不懂，已略過：' + l.trim(), i + 1); return; }
      }
      list.push({ name: name, y: parseFloat(y).toFixed(3), x: parseFloat(x).toFixed(3) });
    });
    return list;
  }

  /** 地號鍵：母號-子號，子號 0 時只寫母號（1、12-3） */
  function parcelLabel(mother, child) {
    mother = String(parseInt(mother, 10)); child = String(parseInt(child || '0', 10));
    return child === '0' ? mother : mother + '-' + child;
  }
  /** 使用者輸入的地號轉成鍵：「12」「12-3」「0012-0003」「12之3」都可以 */
  function parcelKeyOf(s) {
    var m = /^\s*0*(\d+)\s*(?:[-之]\s*0*(\d+))?\s*$/.exec(String(s));
    return m ? parcelLabel(m[1], m[2] || '0') : null;
  }

  function parsePar(text) {
    var list = [];
    splitLines(text).forEach(function (l, i) {
      if (i === 0 || l.length < 30) return;
      var mother = l.slice(0, 4).trim(), child = l.slice(4, 8).trim();
      if (!/^\d+$/.test(mother)) return;
      list.push({ key: parcelLabel(mother, child || '0'), area: l.slice(12, 22).trim(), landUse: l.slice(40, 41).trim() });
    });
    return list;
  }

  function parseBnp(text) {
    var map = {}, order = [];
    splitLines(text).forEach(function (l, i) {
      if (i === 0 || !l.trim()) return;
      var t = l.trim().split(/\s+/);
      if (t.length < 4) return;
      var key = parcelLabel(t[0], t[1]);
      if (!map[key]) { map[key] = []; order.push(key); }
      for (var k = 4; k < t.length; k++) if (/^\d+$/.test(t[k])) map[key].push(String(parseInt(t[k], 10)));
    });
    return { map: map, order: order };
  }

  /**
   * inputs：同一案件的檔案 [{ name, text }]（依副檔名辨認）。
   * opts.parcels：要匯出的地號（陣列；不給 = 全部界址點）
   * opts.ctl：'all'（預設）| 'near'（地號周圍）| 'none'；opts.buffer：公尺（預設 200）
   * 排序一律界址點在前、控制點在後；opts.order：'yx' | 'xy'；opts.ext：'csv' | 'txt'
   */
  function coaToCsv(inputs, opts) {
    opts = opts || {};
    var report = new Report();
    var byExt = {};
    inputs.forEach(function (f) { byExt[extName(f.name)] = f; });
    var base = opts.outName || (inputs.length ? baseName(inputs[0].name) : '未命名');
    var result = { kind: 'coa2csv', files: [], report: report.items, preview: [], parcels: [], perFile: [],
      stats: { points: 0, ctl: 0, bnd: 0, parcels: 0, selected: 0 } };

    if (!byExt.COA) {
      report.error('找不到 .COA 檔（界址點坐標）。同一個資料夾裡要有同名的 .COA，最好也有 .CTL、.BNP、.PAR');
      return result;
    }
    var coa = parseCoa(byExt.COA.text, report);
    var ctl = byExt.CTL ? parseCtl(byExt.CTL.text, report) : [];
    if (!byExt.CTL) report.info('沒有 .CTL 檔，只會輸出界址點（沒有控制點）');
    var bnp = byExt.BNP ? parseBnp(byExt.BNP.text) : null;
    var par = byExt.PAR ? parsePar(byExt.PAR.text) : [];

    // 地號清單（給畫面選）：以 .BNP 為主，補上 .PAR 的面積、地目
    var parInfo = {};
    par.forEach(function (p) { parInfo[p.key] = p; });
    if (bnp) {
      result.parcels = bnp.order.map(function (k) {
        return { key: k, points: bnp.map[k].length, area: parInfo[k] ? parInfo[k].area : '', landUse: parInfo[k] ? parInfo[k].landUse : '' };
      });
      par.forEach(function (p) { if (!bnp.map[p.key]) result.parcels.push({ key: p.key, points: 0, area: p.area, landUse: p.landUse, noMap: true }); });
    }
    result.stats.parcels = result.parcels.length;

    // 界址點
    var bndIds;
    var picked = (opts.parcels || []).map(parcelKeyOf).filter(Boolean);
    if (picked.length) {
      if (!bnp) {
        report.error('沒有 .BNP 檔，無法依地號挑界址點，請改選「全部」');
        bndIds = [];
      } else {
        var seen = {};
        bndIds = [];
        picked.forEach(function (k) {
          if (!bnp.map[k]) {
            report.warn('地號 ' + k + ' 在 .BNP 裡找不到界址點' + (parInfo[k] ? '（地號有簿無圖）' : '（沒有這個地號）'));
            return;
          }
          bnp.map[k].forEach(function (id) { if (!seen[id]) { seen[id] = 1; bndIds.push(id); } });
        });
        result.stats.selected = picked.length;
      }
    } else {
      bndIds = coa.ids.slice();
    }
    var missing = bndIds.filter(function (id) { return !coa.map[id]; });
    if (missing.length) report.warn('有 ' + missing.length + ' 個界址點在 .COA 裡找不到坐標（地籍圖偵錯）：' + missing.slice(0, 10).join('、') + (missing.length > 10 ? '…' : ''));
    var bnd = bndIds.filter(function (id) { return coa.map[id]; }).map(function (id) {
      return { name: id, y: coa.map[id].y, x: coa.map[id].x, type: '界址點', src: byExt.COA.name };
    });

    // 控制點
    // 控制點：all 全部 | nearest 每筆地號取最近 N 點（預設 2，一組兩點：測站＋後視）| none 不要
    //         再加上手動加入（ctlAdd）、扣掉手動移除（ctlRemove）
    var mode = opts.ctl === 'near' ? 'nearest' : (opts.ctl || 'all');
    var nearestN = Math.max(1, parseInt(opts.nearestN, 10) || 2);
    var auto = {};              // 點名 → 自動選入的原因
    if (mode === 'all') ctl.forEach(function (c) { auto[c.name] = '全部'; });
    if (mode === 'nearest' && ctl.length) {
      var groups = picked.length && bnp ? picked.filter(function (k) { return bnp.map[k]; }).map(function (k) {
        return { key: k, ids: bnp.map[k].filter(function (id) { return coa.map[id]; }) };
      }) : [{ key: '全部界址點', ids: bnd.map(function (p) { return p.name; }) }];
      groups.forEach(function (g) {
        if (!g.ids.length) return;
        var cy = 0, cx = 0;
        g.ids.forEach(function (id) { cy += parseFloat(coa.map[id].y); cx += parseFloat(coa.map[id].x); });
        cy /= g.ids.length; cx /= g.ids.length;
        ctl.map(function (c) { return { c: c, d: Math.hypot(parseFloat(c.y) - cy, parseFloat(c.x) - cx) }; })
          .sort(function (a, b) { return a.d - b.d; })
          .slice(0, nearestN)
          .forEach(function (o) {
            var why = '地號 ' + g.key + ' 最近（' + Math.round(o.d) + ' m）';
            auto[o.c.name] = auto[o.c.name] ? auto[o.c.name] + '、' + why : why;
          });
      });
    }
    var add = {}, remove = {};
    (opts.ctlAdd || []).forEach(function (n) { add[n] = 1; });
    (opts.ctlRemove || []).forEach(function (n) { remove[n] = 1; });
    var ctlNames = {};
    ctl.forEach(function (c) { ctlNames[c.name] = 1; });
    Object.keys(add).forEach(function (n) { if (!ctlNames[n]) report.warn('控制點 ' + n + ' 不在 .CTL 裡，已略過'); });
    // 輸出依 .CTL 原本的順序（和舊程式一樣）
    var ctlPts = ctl.filter(function (c) { return (auto[c.name] || add[c.name]) && !remove[c.name]; })
      .map(function (c) { return { name: c.name, y: c.y, x: c.x, type: '控制點', src: byExt.CTL ? byExt.CTL.name : '' }; });
    result.ctlList = ctl.map(function (c) {
      return { name: c.name, auto: auto[c.name] || '', added: !!add[c.name], removed: !!remove[c.name],
        selected: !!((auto[c.name] || add[c.name]) && !remove[c.name]) };
    });
    if (mode === 'nearest' && !ctlPts.length && ctl.length) report.warn('沒有選到任何控制點，請確認地號或手動加入');

    var points = bnd.concat(ctlPts); // 界址點 → 控制點
    result.order = opts.order === 'xy' ? 'xy' : 'yx';
    result.preview = points;
    result.stats.points = points.length;
    result.stats.ctl = ctlPts.length;
    result.stats.bnd = bnd.length;
    result.stats.totalBnd = coa.ids.length;
    result.stats.totalCtl = ctl.length;
    result.perFile = [{ name: byExt.CTL ? byExt.CTL.name : '', type: '控制點', count: ctlPts.length }, { name: byExt.COA.name, type: '界址點', count: bnd.length }];
    if (!points.length) { report.error('沒有任何點可以輸出'); return result; }
    // 檔名：同舊程式，有挑地號時加上地號（KC1117 + 1_2_3 → KC11171_2_3）
    var outBase = base;
    if (!opts.outName && picked.length) {
      outBase = base + (picked.length <= 6 ? picked.join('_') : picked.slice(0, 3).join('_') + '等' + picked.length + '筆');
    }
    result.files.push(writePoints(points, outBase, opts, '控制點 ' + ctlPts.length + '、界址點 ' + bnd.length));
    return result;
  }

  // ───────────────────────── 輸出格式 ─────────────────────────

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function padR(s, w) { s = String(s); while (s.length < w) s += ' '; return s; }

  /**
   * 把點位寫成儀器檔：
   *   'csv'    點號,Y,X（或 X,Y），副檔名 .csv / .txt
   *   'sdr'    SOKKIA SDR33：BOM + 00NM/10NM 標頭 + 每點 08KI＋5 個 16 字欄（同「複丈輸入檔2SOKKIA」）
   *   'topcon' TOPCON：點號,Y,X,0.000,1（同「複丈輸入檔2SOKKIA」）
   */
  function writePoints(points, base, opts, summary) {
    var fmt = opts.format || 'csv';
    if (fmt === 'sdr') {
      var d = opts.now ? new Date(opts.now) : new Date();
      var stamp = pad(d.getDate(), 2) + '-' + MONTHS[d.getMonth()] + '-' + pad(d.getFullYear() % 100, 2) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2);
      var rows = ['00NMSDR33 V04-04.02     ' + stamp + ' 111111', '10NM' + padR('', 16) + '121111'];
      points.forEach(function (p) { rows.push('08KI' + padR(p.name, 16) + padR(p.y, 16) + padR(p.x, 16) + padR('0.', 16) + padR('1', 16)); });
      return { name: base + '.sdr', content: '\uFEFF' + joinLines(rows), main: true, desc: 'SOKKIA 格式（' + summary + '）' };
    }
    if (fmt === 'topcon') {
      return { name: base + '.txt', content: joinLines(points.map(function (p) { return [p.name, p.y, p.x, '0.000', '1'].join(','); })),
        main: true, desc: 'TOPCON 格式：點號,Y,X,0.000,1（' + summary + '）' };
    }
    var xy = opts.order === 'xy';
    var ext = opts.ext === 'txt' ? 'txt' : 'csv';
    return { name: base + '.' + ext, content: joinLines(points.map(function (p) { return xy ? [p.name, p.x, p.y].join(',') : [p.name, p.y, p.x].join(','); })),
      main: true, desc: '全站儀、GPS 控制器都能匯入：點號,' + (xy ? 'X,Y' : 'Y,X') + '（' + summary + '）' };
  }

  // ═════════════ 5. 直接寫入重測系統檔（.D14 參考點／.D20 補點，dBASE III） ═════════════
  //
  // .D14 COT：COT_NUMBER N5、COT_REF N2（編碼）、COT_Y N16.8、COT_X N15.8、COT_MATTER N2、
  //           COT_SOURCE N1（2 = 計算求得）、COT_SURVEY N2、COT_MSE N2、COT_REMARK C12、TAU_ID N3
  //           同一點號可有不同編碼（例如 5 號界址點 5.00 與 5 號參考點 5.30），點號＋編碼才是唯一。
  // .D20 CTL：CTL_NAME C8、CTL_Y N12.3、CTL_X N11.3、CTL_LEVEL C3（補點 Q）、CTL_MATTER/SITUAT/LAND C1、CTL_MODE L

  function toU8(b) {
    if (b instanceof Uint8Array) return b;
    if (b instanceof ArrayBuffer) return new Uint8Array(b);
    return new Uint8Array(b);
  }
  function bytesToStr(u8, a, n) {
    var s = '';
    for (var i = a; i < a + n; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function parseDbf(bytes) {
    var u8 = toU8(bytes);
    if (u8.length < 33 || (u8[0] & 0x07) !== 3) throw new Error('不是 dBASE III 檔');
    var nrec = u8[4] | (u8[5] << 8) | (u8[6] << 16) | (u8[7] << 24);
    var hlen = u8[8] | (u8[9] << 8), rlen = u8[10] | (u8[11] << 8);
    var fields = [], off = 32, pos = 1;
    while (off < hlen - 1 && u8[off] !== 0x0D) {
      var name = bytesToStr(u8, off, 11).replace(/\0.*$/, '');
      var f = { name: name, type: String.fromCharCode(u8[off + 11]), len: u8[off + 16], dec: u8[off + 17], pos: pos };
      fields.push(f); pos += f.len; off += 32;
    }
    var records = [];
    for (var i = 0; i < nrec; i++) {
      var base = hlen + i * rlen;
      if (base + rlen > u8.length) break;
      var rec = { deleted: u8[base] === 0x2A, values: {} };
      fields.forEach(function (fd) { rec.values[fd.name] = bytesToStr(u8, base + fd.pos, fd.len); });
      records.push(rec);
    }
    var dataEnd = hlen + nrec * rlen;
    return { u8: u8, nrec: nrec, hlen: hlen, rlen: rlen, fields: fields, records: records,
      hasEof: u8.length > dataEnd && u8[dataEnd] === 0x1A };
  }

  function encodeField(fd, v) {
    var s;
    if (fd.type === 'N' || fd.type === 'F') {
      if (v === '' || v == null) s = '';
      else s = typeof v === 'number' ? (fd.dec ? v.toFixed(fd.dec) : String(Math.round(v))) : String(v);
      if (s.length > fd.len) throw new Error('欄位 ' + fd.name + ' 放不下「' + s + '」（最多 ' + fd.len + ' 字）');
      while (s.length < fd.len) s = ' ' + s;
      return s;
    }
    if (fd.type === 'L') return v ? 'T' : 'F';
    s = String(v == null ? '' : v);
    if (s.length > fd.len) throw new Error('欄位 ' + fd.name + ' 放不下「' + s + '」（最多 ' + fd.len + ' 字）');
    while (s.length < fd.len) s += ' ';
    return s;
  }

  /** 在原檔後面加上新紀錄，回傳新檔的 Uint8Array（更新筆數與日期，其餘位元組原封不動） */
  function appendDbf(db, rows, now) {
    var d = now ? new Date(now) : new Date();
    var n = rows.length;
    var dataEnd = db.hlen + db.nrec * db.rlen;
    var out = new Uint8Array(dataEnd + n * db.rlen + (db.hasEof ? 1 : 0));
    out.set(db.u8.subarray(0, dataEnd), 0);
    out[1] = d.getFullYear() - 1900; out[2] = d.getMonth() + 1; out[3] = d.getDate();
    var total = db.nrec + n;
    out[4] = total & 255; out[5] = (total >> 8) & 255; out[6] = (total >> 16) & 255; out[7] = (total >> 24) & 255;
    // 沒指定的欄位沿用最後一筆的內容（例如 D20 的 \0 與 T），沒有舊紀錄時用空白
    var tmpl = db.nrec ? db.u8.subarray(dataEnd - db.rlen, dataEnd) : null;
    rows.forEach(function (row, i) {
      var base = dataEnd + i * db.rlen;
      if (tmpl) out.set(tmpl, base); else for (var k = 0; k < db.rlen; k++) out[base + k] = 0x20;
      out[base] = 0x20;
      db.fields.forEach(function (fd) {
        if (!tmpl && fd.type === 'L') out[base + fd.pos] = 0x54;
        if (!Object.prototype.hasOwnProperty.call(row, fd.name)) return;
        var str = encodeField(fd, row[fd.name]);
        for (var k = 0; k < fd.len; k++) out[base + fd.pos + k] = str.charCodeAt(k) & 255;
      });
    });
    if (db.hasEof) out[out.length - 1] = 0x1A;
    return out;
  }

  /**
   * D14 已有的參考點（編碼不是 00 的，X.XX）：點號 → 紀錄；以及參考點目前最大點號。
   * 編碼 00 的是計算求得的界址點（X.00），不算在內。
   */
  function d14Index(db) {
    var refByNum = {}, maxRef = 0, keys = {};
    (db ? db.records : []).forEach(function (r) {
      if (r.deleted) return;
      var num = parseInt(r.values.COT_NUMBER, 10), ref = parseInt(r.values.COT_REF, 10) || 0;
      if (!isFinite(num)) return;
      keys[num + '.' + ref] = 1;
      if (ref === 0) return;
      (refByNum[num] = refByNum[num] || []).push({ ref: ref, y: parseFloat(r.values.COT_Y), x: parseFloat(r.values.COT_X) });
      if (num > maxRef) maxRef = num;
    });
    return { refByNum: refByNum, maxRef: maxRef, keys: keys };
  }
  function d20Index(db) {
    var names = {};
    (db ? db.records : []).forEach(function (r) {
      if (!r.deleted) names[r.values.CTL_NAME.trim().toUpperCase()] = { y: parseFloat(r.values.CTL_Y), x: parseFloat(r.values.CTL_X) };
    });
    return names;
  }

  /** 已知坐標表（給全站儀 RAW 算坐標用）：D20 點名、D14「點號」（唯一時）與「點號.編碼」 */
  function knownFromDbf(d14, d20) {
    var known = {}, byNum = {};
    (d20 ? d20.records : []).forEach(function (r) {
      if (r.deleted) return;
      known[r.values.CTL_NAME.trim()] = { N: parseFloat(r.values.CTL_Y), E: parseFloat(r.values.CTL_X) };
    });
    (d14 ? d14.records : []).forEach(function (r) {
      if (r.deleted) return;
      var num = parseInt(r.values.COT_NUMBER, 10), ref = parseInt(r.values.COT_REF, 10) || 0;
      var P = { N: parseFloat(r.values.COT_Y), E: parseFloat(r.values.COT_X) };
      known[num + '.' + pad(ref, 2)] = P;
      (byNum[num] = byNum[num] || []).push(P);
    });
    Object.keys(byNum).forEach(function (n) { if (byNum[n].length === 1 && !known[n]) known[n] = byNum[n][0]; });
    return known;
  }

  function nextFreeName(name, used) {
    var m = /^(.*?)(\d+)$/.exec(name);
    var cand, i;
    if (m) {
      for (i = parseInt(m[2], 10) + 1; ; i++) { cand = m[1] + i; if (!used[cand.toUpperCase()]) return cand; }
    }
    for (i = 1; ; i++) { cand = name + '-' + i; if (!used[cand.toUpperCase()]) return cand; }
  }

  var NEAR_M = 0.06; // 6 公分內視為同一點重測

  /**
   * 規劃要寫進 D14／D20 的點：
   *   點名 Q 開頭 → D20 補點；數字點號 → D14 參考點（點號＋編碼）；其他 → 不能寫入
   *   參考點點號已被用過（D14 任何 X.XX 參考點，或這批資料）→ 改成參考點最大號＋1
   *   同點號／同補點名稱且坐標相差 6 公分內 → 視為重測，預設不寫入並列出差值；
   *     使用者勾選寫入時，改成參考點（最大號＋1，編碼預設 11）寫進 D14
   * points：[{ key, name, code, y, x, src, line }]
   * edits：{ key: { num, ref, name, skip, write } }
   */
  function planDbfWrite(input) {
    var d14 = input.d14, d20 = input.d20, edits = input.edits || {};
    var badTo = String(input.badCodeTo || '11');
    var idx14 = d14Index(d14), idx20 = d20Index(d20);
    var usedNum = {}, used20 = {}, maxRef = idx14.maxRef;
    Object.keys(idx14.refByNum).forEach(function (n) { usedNum[n] = 1; });
    Object.keys(idx20).forEach(function (k) { used20[k] = 1; });
    var rows = [];
    var cm = function (d) { return d < 1 ? (d * 100).toFixed(1) + ' cm' : d < 1000 ? d.toFixed(1) + ' m' : (d / 1000).toFixed(1) + ' km'; };
    var nextNum = function () { maxRef += 1; while (usedNum[maxRef]) maxRef++; return maxRef; };
    var take = function (row, num, ref) {
      row.target = 'D14'; row.num = num; row.ref = ref;
      usedNum[num] = 1; if (num > maxRef) maxRef = num;
      row.out = num + '.' + pad(ref, 2);
    };

    (input.points || []).forEach(function (p) {
      var e = edits[p.key] || {};
      var row = { key: p.key, origName: p.name, origCode: p.code == null ? '' : p.code, y: Number(p.y), x: Number(p.x), src: p.src, line: p.line, file: p.file,
        status: '', reason: '' };
      var name = String(p.name).trim();
      if (/^q/i.test(name)) row.target = 'D20';
      else if (/^\d+$/.test(name)) row.target = 'D14';
      else { row.target = null; row.status = 'skip'; row.reason = '點名不是數字也不是 Q 開頭，無法寫入'; rows.push(row); return; }
      if (e.skip) { row.status = 'excluded'; row.reason = '不寫入'; rows.push(row); return; }

      // 6 公分內的重測點
      var near = null;
      if (row.target === 'D20' && idx20[name.toUpperCase()]) {
        var q = idx20[name.toUpperCase()];
        near = { d: Math.hypot(q.y - row.y, q.x - row.x), what: 'D20 已有補點 ' + name };
      } else if (row.target === 'D14' && idx14.refByNum[parseInt(name, 10)]) {
        idx14.refByNum[parseInt(name, 10)].forEach(function (c) {
          var d = Math.hypot(c.y - row.y, c.x - row.x);
          if (!near || d < near.d) near = { d: d, what: 'D14 已有參考點 ' + parseInt(name, 10) + '.' + pad(c.ref, 2) };
        });
      }
      if (near) row.dist = near.d;
      if (near && near.d <= NEAR_M) {
        row.near = true;
        if (!e.write) {
          row.status = 'near';
          row.reason = near.what + '，相差 ' + cm(near.d) + '（6 cm 內，視為同一點重測，預設不寫入；要寫入請打勾）';
          rows.push(row); return;
        }
        if (!d14) { row.status = 'noFile'; row.reason = '要寫成參考點，但沒有放入 .D14'; rows.push(row); return; }
        var wref = e.ref != null && e.ref !== '' ? parseInt(e.ref, 10) : (row.target === 'D14' && p.code ? parseInt(p.code, 10) : parseInt(badTo, 10));
        if (!(wref >= 1 && wref <= 99)) { row.target = 'D14'; row.status = 'needCode'; row.reason = '請填編碼（01～99）'; rows.push(row); return; }
        var wn = e.num != null && e.num !== '' ? parseInt(e.num, 10) : null;
        if (wn != null && usedNum[wn]) { row.target = 'D14'; row.num = wn; row.ref = wref; row.status = 'conflict'; row.reason = '你指定的點號 ' + wn + ' 已經有參考點了'; rows.push(row); return; }
        take(row, wn != null ? wn : nextNum(), wref);
        row.status = 'remeasure';
        row.reason = near.what + '（差 ' + cm(near.d) + '），依你的選擇寫成新的參考點 ' + row.out;
        rows.push(row); return;
      }

      if (row.target === 'D14' && !d14) { row.status = 'noFile'; row.reason = '沒有放入 .D14'; rows.push(row); return; }
      if (row.target === 'D20' && !d20) { row.status = 'noFile'; row.reason = '沒有放入 .D20'; rows.push(row); return; }

      if (row.target === 'D14') {
        var num = e.num != null && e.num !== '' ? parseInt(e.num, 10) : parseInt(name, 10);
        var refRaw = e.ref != null && e.ref !== '' ? e.ref : p.code;
        var ref = refRaw === '' || refRaw == null ? null : parseInt(refRaw, 10);
        row.num = num; row.ref = ref;
        if (ref === null || !isFinite(ref) || ref < 0 || ref > 99) { row.status = 'needCode'; row.reason = '缺編碼（00～99），請填'; rows.push(row); return; }
        if (!(num >= 1 && num <= 99999)) { row.status = 'conflict'; row.reason = '點號要是 1～99999'; rows.push(row); return; }
        if (usedNum[num]) {
          if (e.num != null && e.num !== '') { row.status = 'conflict'; row.reason = '你指定的點號 ' + num + ' 已經有參考點了'; rows.push(row); return; }
          var from = num;
          take(row, nextNum(), ref);
          row.status = 'renumbered';
          row.reason = (idx14.refByNum[from] ? 'D14 已有參考點 ' + from + '.xx' + (near ? '（相差 ' + cm(near.d) + '，不是同一點）' : '') : '這批資料裡重複 ' + from) +
            '，改成參考點最大號＋1：' + row.out;
        } else {
          take(row, num, ref);
          row.status = e.num != null && e.num !== '' ? 'edited' : 'new';
        }
      } else {
        var nm = e.name ? String(e.name).trim() : name;
        if (nm.length > 8) { row.status = 'conflict'; row.reason = '補點名稱最多 8 個字'; row.name = nm; rows.push(row); return; }
        if (used20[nm.toUpperCase()]) {
          if (e.name) { row.status = 'conflict'; row.reason = '你指定的 ' + nm + ' 已經有了'; row.name = nm; rows.push(row); return; }
          var nn2 = nextFreeName(nm, used20);
          if (nn2.length > 8) { row.status = 'conflict'; row.reason = nm + ' 已存在，自動改號後超過 8 個字，請手動指定'; row.name = nm; rows.push(row); return; }
          row.reason = (idx20[nm.toUpperCase()] ? 'D20 已有 ' + nm + (near ? '（相差 ' + cm(near.d) + '，不是同一點）' : '') : '這批資料裡重複 ' + nm) + '，自動改成 ' + nn2;
          row.status = 'renumbered'; nm = nn2;
        } else row.status = e.name ? 'edited' : 'new';
        used20[nm.toUpperCase()] = 1;
        row.name = nm; row.out = nm;
      }
      rows.push(row);
    });

    var ok = rows.filter(function (r) { return r.status === 'new' || r.status === 'renumbered' || r.status === 'edited' || r.status === 'remeasure'; });
    var blocking = rows.filter(function (r) { return r.status === 'needCode' || r.status === 'conflict'; });
    return {
      rows: rows,
      toD14: ok.filter(function (r) { return r.target === 'D14'; }),
      toD20: ok.filter(function (r) { return r.target === 'D20'; }),
      blocking: blocking,
      near: rows.filter(function (r) { return r.status === 'near'; }).length,
      renumbered: rows.filter(function (r) { return r.status === 'renumbered'; }).length
    };
  }

  /** 依規劃產生新的 D14／D20 位元組與對照表 */
  function buildDbfFiles(plan, d14, d20, now) {
    var out = {};
    if (d14 && plan.toD14.length) {
      out.d14 = appendDbf(d14, plan.toD14.map(function (r) {
        return { COT_NUMBER: r.num, COT_REF: r.ref, COT_Y: Number(r.y), COT_X: Number(r.x), COT_MATTER: 0, COT_SOURCE: 2,
          COT_SURVEY: 0, COT_MSE: 0, COT_REMARK: '', TAU_ID: '' };
      }), now);
    }
    if (d20 && plan.toD20.length) {
      out.d20 = appendDbf(d20, plan.toD20.map(function (r) {
        return { CTL_NAME: r.name, CTL_Y: Number(r.y), CTL_X: Number(r.x), CTL_LEVEL: 'Q' };
      }), now);
    }
    var STATUS = { new: '新增', renumbered: '自動改號', edited: '手動指定', needCode: '缺編碼', conflict: '衝突', skip: '無法寫入', excluded: '不寫入', noFile: '缺檔案',
      near: '重測（未寫入）', remeasure: '重測→新參考點' };
    var cell = function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [['原點名', '原編碼', '寫入檔案', '寫入點號', 'Y', 'X', '與已有點相差(cm)', '來源', '狀態', '說明'].join(',')];
    plan.rows.forEach(function (r) {
      lines.push([r.origName, r.origCode, r.target && r.out ? '.' + r.target : '', r.out || '', Number(r.y).toFixed(3), Number(r.x).toFixed(3),
        r.dist != null ? (r.dist * 100).toFixed(1) : '', r.src, STATUS[r.status] || r.status, r.reason].map(cell).join(','));
    });
    out.table = '\uFEFF' + joinLines(lines);
    return out;
  }

  // ═════════════ 6. 航照底圖（國土測繪中心 WMTS）與坐標換算 ═════════════
  //
  // TWD97 TM2（EPSG:3826）：GRS80 橢球、中央經線 121°、k0 = 0.9999、東偏 250000 m
  // 底圖來源：
  //   PHOTO2     正射影像圖(通用)，Web Mercator，第 20 層約 0.14 m／像素（需轉投影）
  //   PHOTO3826  正射影像圖(通用)_3826，TWD97 原生，第 13 層 0.2646 m／像素（不用轉投影）

  var GRS80_A = 6378137, GRS80_F = 1 / 298.257222101;
  var TM2 = { lon0: 121, k0: 0.9999, fe: 250000, fn: 0 };

  function tmConsts() {
    var a = GRS80_A, f = GRS80_F, e2 = f * (2 - f), n = f / (2 - f);
    var A = a / (1 + n) * (1 + n * n / 4 + Math.pow(n, 4) / 64);
    var al = [n / 2 - 2 * n * n / 3 + 5 * Math.pow(n, 3) / 16, 13 * n * n / 48 - 3 * Math.pow(n, 3) / 5, 61 * Math.pow(n, 3) / 240];
    var be = [n / 2 - 2 * n * n / 3 + 37 * Math.pow(n, 3) / 96, n * n / 48 + Math.pow(n, 3) / 15, 17 * Math.pow(n, 3) / 480];
    var de = [2 * n - 2 * n * n / 3 - 2 * Math.pow(n, 3), 7 * n * n / 3 - 8 * Math.pow(n, 3) / 5, 56 * Math.pow(n, 3) / 15];
    return { e2: e2, n: n, A: A, al: al, be: be, de: de };
  }
  var TMC = tmConsts();
  var D2R = Math.PI / 180;

  /** 經緯度（度）→ TWD97 TM2 [E, N]（Krüger 級數，精度遠優於 1 mm） */
  function lonLatToTwd97(lon, lat) {
    var c = TMC, phi = lat * D2R, lam = (lon - TM2.lon0) * D2R;
    var e = Math.sqrt(c.e2);
    var t = Math.sinh(atanh(Math.sin(phi)) - e * atanh(e * Math.sin(phi)));
    var xi = Math.atan2(t, Math.cos(lam)), eta = atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
    var x = xi, y = eta;
    for (var j = 1; j <= 3; j++) { x += c.al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); y += c.al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
    return [TM2.fe + TM2.k0 * c.A * y, TM2.fn + TM2.k0 * c.A * x];
  }
  /** TWD97 TM2 [E, N] → 經緯度（度）[lon, lat] */
  function twd97ToLonLat(E, N) {
    var c = TMC;
    var xi = (N - TM2.fn) / (TM2.k0 * c.A), eta = (E - TM2.fe) / (TM2.k0 * c.A);
    var x = xi, y = eta;
    for (var j = 1; j <= 3; j++) { x -= c.be[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); y -= c.be[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
    var chi = Math.asin(Math.sin(x) / Math.cosh(y));
    var phi = chi;
    for (j = 1; j <= 3; j++) phi += c.de[j - 1] * Math.sin(2 * j * chi);
    var lam = Math.atan2(Math.sinh(y), Math.cos(x));
    return [TM2.lon0 + lam / D2R, phi / D2R];
  }
  function atanh(x) { return 0.5 * Math.log((1 + x) / (1 - x)); }

  /** 經緯度 → Web Mercator 全域像素（第 z 層，256 像素磁磚） */
  function lonLatToMercPx(lon, lat, z) {
    var n = 256 * Math.pow(2, z), s = Math.sin(lat * D2R);
    return [(lon + 180) / 360 * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }

  var BASEMAP_SOURCES = {
    PHOTO2: { label: '正射影像圖(通用)・約 0.14 m', kind: 'merc', zoom: 20,
      url: 'https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{row}/{col}' },
    PHOTO3826: { label: '正射影像圖(通用)_3826・0.26 m（TWD97 原生）', kind: 'tm2', zoom: 13, res: 944.9423660750896 * 0.00028,
      originE: 50000, originN: 3000000,
      url: 'https://wmts.nlsc.gov.tw/97/wmts/PHOTO3826/default/default028mm/{z}/{row}/{col}' }
  };

  /** 點位的範圍（N、E），外擴 margin 公尺 */
  function pointsBBox(points, margin) {
    var m = margin == null ? 30 : margin;
    var b = { minE: Infinity, maxE: -Infinity, minN: Infinity, maxN: -Infinity, count: 0 };
    points.forEach(function (p) {
      var E = Number(p.E), N = Number(p.N);
      if (!isFinite(E) || !isFinite(N) || !isYVal(N) || !isXVal(E)) return;
      b.minE = Math.min(b.minE, E); b.maxE = Math.max(b.maxE, E); b.minN = Math.min(b.minN, N); b.maxN = Math.max(b.maxN, N); b.count++;
    });
    if (!b.count) return null;
    b.minE -= m; b.maxE += m; b.minN -= m; b.maxN += m;
    return b;
  }

  /**
   * 點位分群（相距 link 公尺以內的點連成一群），由大到小排序。用來排除離主要範圍很遠的零星點。
   */
  function splitClusters(points, link) {
    link = link || 150;
    var pts = points.filter(function (p) { return isFinite(p.E) && isFinite(p.N); });
    var parent = pts.map(function (_, i) { return i; });
    var find = function (i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    var grid = {};
    pts.forEach(function (p, i) { var k = Math.floor(p.E / link) + ',' + Math.floor(p.N / link); (grid[k] = grid[k] || []).push(i); });
    pts.forEach(function (p, i) {
      var cx = Math.floor(p.E / link), cy = Math.floor(p.N / link);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        (grid[(cx + dx) + ',' + (cy + dy)] || []).forEach(function (j) {
          if (j <= i) return;
          if (Math.hypot(pts[j].E - p.E, pts[j].N - p.N) <= link) { var a = find(i), b = find(j); if (a !== b) parent[a] = b; }
        });
      }
    });
    var groups = {};
    pts.forEach(function (p, i) { var r = find(i); (groups[r] = groups[r] || []).push(p); });
    return Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return b.length - a.length; });
  }

  /**
   * 底圖範圍：取點最多的那一群（其他離很遠的零星點不算，除非 includeAll），
   * 以這群的中心為圖的中心，四周外擴 margin，且邊長至少 minSize 公尺。
   * 回傳 { bbox, center, main, outliers, size:[寬,高] }
   */
  function basemapArea(points, opt) {
    opt = opt || {};
    var margin = opt.margin == null ? 30 : opt.margin, minSize = opt.minSize == null ? 200 : opt.minSize;
    var ok = points.filter(function (p) { p.E = Number(p.E); p.N = Number(p.N); return isFinite(p.E) && isFinite(p.N) && isYVal(p.N) && isXVal(p.E); });
    if (!ok.length) return null;
    var cl = splitClusters(ok, opt.link || 150);
    var main = opt.includeAll ? ok : cl[0], outliers = opt.includeAll ? [] : [].concat.apply([], cl.slice(1));
    var b = pointsBBox(main, 0);
    var cE = (b.minE + b.maxE) / 2, cN = (b.minN + b.maxN) / 2;
    var hw = Math.max((b.maxE - b.minE) / 2 + margin, minSize / 2), hh = Math.max((b.maxN - b.minN) / 2 + margin, minSize / 2);
    return { bbox: { minE: cE - hw, maxE: cE + hw, minN: cN - hh, maxN: cN + hh, count: main.length },
      center: { E: cE, N: cN }, main: main, outliers: outliers, size: [2 * hw, 2 * hh] };
  }

  /**
   * 航照偏差：配對「航照上讀到的位置」與「實測位置」，位移 = 實測 − 航照（取平均）。
   * pairs：[{ img: {N, E}, real: {N, E}, label }] → { dN, dE, n, residuals: [mm…], maxResidual }
   */
  function shiftFromPairs(pairs) {
    var ok = (pairs || []).filter(function (p) { return p && p.img && p.real; });
    if (!ok.length) return null;
    var dN = 0, dE = 0;
    ok.forEach(function (p) { dN += p.real.N - p.img.N; dE += p.real.E - p.img.E; });
    dN /= ok.length; dE /= ok.length;
    var res = ok.map(function (p) { return Math.hypot(p.real.N - p.img.N - dN, p.real.E - p.img.E - dE); });
    return { dN: dN, dE: dE, n: ok.length, dist: Math.hypot(dN, dE), residuals: res, maxResidual: Math.max.apply(null, res) };
  }

  /**
   * 從 D14 自動找航照判讀點：編碼 imgRef（預設 87）的點，配對最近的其他參考點（編碼不是 00、也不是 imgRef），
   * 距離 maxDist（預設 10 m）以內才配。
   */
  function suggestImagePairs(d14, imgRef, maxDist) {
    var pts = [];
    (d14 ? d14.records : []).forEach(function (r) {
      if (r.deleted) return;
      var num = parseInt(r.values.COT_NUMBER, 10), ref = parseInt(r.values.COT_REF, 10) || 0;
      pts.push({ num: num, ref: ref, label: num + '.' + pad(ref, 2), N: parseFloat(r.values.COT_Y), E: parseFloat(r.values.COT_X) });
    });
    return imagePairsFromPoints(pts, imgRef, maxDist);
  }
  /** points：[{ label, ref（編碼）, N, E }] */
  function imagePairsFromPoints(points, imgRef, maxDist) {
    imgRef = imgRef == null ? 87 : imgRef; maxDist = maxDist || 10;
    var img = [], real = [];
    points.forEach(function (P) {
      if (!isFinite(P.N) || !isFinite(P.E)) return;
      if (P.ref === imgRef) img.push(P); else if (P.ref !== 0 && P.ref != null) real.push(P);
    });
    return img.map(function (p) {
      var best = null;
      real.forEach(function (q) { var d = Math.hypot(q.N - p.N, q.E - p.E); if (d <= maxDist && (!best || d < best.d)) best = { q: q, d: d }; });
      return { img: p, real: best ? best.q : null, dist: best ? best.d : null, label: p.label + (best ? ' ↔ ' + best.q.label : '') };
    });
  }

  /**
   * 規劃要抓的範圍：bbox 是「實測坐標」，影像要往回移 shift 才對得上。
   * 回傳 { width, height, res, ulE, ulN（左上像素中心，已含校正）, tiles:[{z,row,col,url}], source }
   */
  function planBasemap(bbox, sourceKey, shift, maxPixels) {
    var src = BASEMAP_SOURCES[sourceKey] || BASEMAP_SOURCES.PHOTO2;
    var plan;
    // 範圍太大時自動降一層（解析度減半），最多降 4 層
    for (var z = src.zoom; z >= src.zoom - 4; z--) {
      plan = planAt(bbox, sourceKey, src, z, shift, maxPixels);
      if (!plan.tooBig) break;
    }
    plan.reduced = src.zoom - plan.zoom;
    return plan;
  }
  function planAt(bbox, sourceKey, src, zoom, shift, maxPixels) {
    var sh = shift || { dN: 0, dE: 0 };
    var limit = maxPixels || 25e6;
    var tiles = [], plan = { source: sourceKey, kind: src.kind, zoom: zoom };
    if (src.kind === 'tm2') {
      // 影像坐標 = 實測 − shift；直接沿用磁磚的像素格，不用重新取樣
      var r = src.res * Math.pow(2, src.zoom - zoom), span = 256 * r;
      var iMinE = bbox.minE - sh.dE, iMaxE = bbox.maxE - sh.dE, iMinN = bbox.minN - sh.dN, iMaxN = bbox.maxN - sh.dN;
      var c0 = Math.floor((iMinE - src.originE) / span), c1 = Math.floor((iMaxE - src.originE) / span);
      var r0 = Math.floor((src.originN - iMaxN) / span), r1 = Math.floor((src.originN - iMinN) / span);
      var px0 = Math.floor((iMinE - src.originE) / r), px1 = Math.ceil((iMaxE - src.originE) / r);
      var py0 = Math.floor((src.originN - iMaxN) / r), py1 = Math.ceil((src.originN - iMinN) / r);
      plan.res = r; plan.width = px1 - px0; plan.height = py1 - py0;
      plan.cropX = px0 - c0 * 256; plan.cropY = py0 - r0 * 256;
      plan.tileCols = c1 - c0 + 1; plan.tileRows = r1 - r0 + 1;
      plan.ulE = src.originE + (px0 + 0.5) * r + sh.dE;
      plan.ulN = src.originN - (py0 + 0.5) * r + sh.dN;
      for (var row = r0; row <= r1; row++) for (var col = c0; col <= c1; col++) {
        tiles.push({ z: zoom, row: row, col: col, dx: (col - c0) * 256, dy: (row - r0) * 256, url: src.url.replace('{z}', zoom).replace('{row}', row).replace('{col}', col) });
      }
    } else {
      // Web Mercator：輸出用 TWD97 格網（像素大小取磁磚在當地的地面解析度），每個像素反算回磁磚取樣
      var z = zoom;
      var ll = twd97ToLonLat((bbox.minE + bbox.maxE) / 2, (bbox.minN + bbox.maxN) / 2);
      var res = 2 * Math.PI * GRS80_A / (256 * Math.pow(2, z)) * Math.cos(ll[1] * D2R);
      res = Math.round(res * 1e4) / 1e4;
      plan.res = res;
      plan.width = Math.ceil((bbox.maxE - bbox.minE) / res);
      plan.height = Math.ceil((bbox.maxN - bbox.minN) / res);
      plan.ulE = bbox.minE + res / 2; plan.ulN = bbox.maxN - res / 2;
      // 需要的磁磚：影像坐標（實測 − shift）四角與邊上取點轉成墨卡托像素
      var mx0 = Infinity, mx1 = -Infinity, my0 = Infinity, my1 = -Infinity;
      for (var i = 0; i <= 8; i++) for (var k = 0; k <= 8; k++) {
        var E = bbox.minE + (bbox.maxE - bbox.minE) * i / 8 - sh.dE, N = bbox.minN + (bbox.maxN - bbox.minN) * k / 8 - sh.dN;
        var g = twd97ToLonLat(E, N), m = lonLatToMercPx(g[0], g[1], z);
        mx0 = Math.min(mx0, m[0]); mx1 = Math.max(mx1, m[0]); my0 = Math.min(my0, m[1]); my1 = Math.max(my1, m[1]);
      }
      var tc0 = Math.floor(mx0 / 256) , tc1 = Math.floor(mx1 / 256), tr0 = Math.floor(my0 / 256), tr1 = Math.floor(my1 / 256);
      plan.tileCols = tc1 - tc0 + 1; plan.tileRows = tr1 - tr0 + 1;
      plan.mercOriginX = tc0 * 256; plan.mercOriginY = tr0 * 256;
      for (var rr = tr0; rr <= tr1; rr++) for (var cc = tc0; cc <= tc1; cc++) {
        tiles.push({ z: z, row: rr, col: cc, dx: (cc - tc0) * 256, dy: (rr - tr0) * 256, url: src.url.replace('{z}', z).replace('{row}', rr).replace('{col}', cc) });
      }
    }
    plan.tiles = tiles;
    plan.tooBig = plan.width * plan.height > limit || tiles.length > 2500;
    plan.areaM = [(bbox.maxE - bbox.minE), (bbox.maxN - bbox.minN)];
    return plan;
  }

  /**
   * 輸出像素 (i, j) → 磁磚拼圖上的像素位置（Web Mercator 來源用）。已含校正：實測坐標 − shift = 影像坐標。
   */
  function basemapSampler(plan, shift) {
    var sh = shift || { dN: 0, dE: 0 };
    return function (i, j) {
      var E = plan.ulE + i * plan.res - sh.dE, N = plan.ulN - j * plan.res - sh.dN;
      var g = twd97ToLonLat(E, N), m = lonLatToMercPx(g[0], g[1], plan.zoom);
      return [m[0] - plan.mercOriginX - 0.5, m[1] - plan.mercOriginY - 0.5];
    };
  }

  /**
   * Web Mercator 拼圖 → TWD97 格網（雙線性內插）。src：RGBA 陣列（拼圖），回傳 RGBA（plan.width × plan.height）。
   * 坐標換算每 16 像素算一次精確值、中間線性內插（誤差遠小於 1 mm）。拼不到的地方填白色。
   */
  function resampleMercToTm2(src, srcW, srcH, plan, shift) {
    var W = plan.width, H = plan.height, out = new Uint8ClampedArray(W * H * 4);
    var f = basemapSampler(plan, shift), STEP = 16;
    var gw = Math.ceil(W / STEP) + 1, gh = Math.ceil(H / STEP) + 1, gx = new Float64Array(gw * gh), gy = new Float64Array(gw * gh);
    for (var b = 0; b < gh; b++) for (var a = 0; a < gw; a++) { var m = f(a * STEP, b * STEP); gx[b * gw + a] = m[0]; gy[b * gw + a] = m[1]; }
    for (var j = 0; j < H; j++) {
      var bj = Math.floor(j / STEP), tj = (j - bj * STEP) / STEP;
      for (var i = 0; i < W; i++) {
        var ai = Math.floor(i / STEP), ti = (i - ai * STEP) / STEP, k = bj * gw + ai;
        var x = (gx[k] * (1 - ti) + gx[k + 1] * ti) * (1 - tj) + (gx[k + gw] * (1 - ti) + gx[k + gw + 1] * ti) * tj;
        var y = (gy[k] * (1 - ti) + gy[k + 1] * ti) * (1 - tj) + (gy[k + gw] * (1 - ti) + gy[k + gw + 1] * ti) * tj;
        var o = (j * W + i) * 4;
        var x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        if (x0 < 0 || y0 < 0 || x0 + 1 >= srcW || y0 + 1 >= srcH) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 255; continue; }
        var p00 = (y0 * srcW + x0) * 4, p10 = p00 + 4, p01 = p00 + srcW * 4, p11 = p01 + 4;
        for (var c = 0; c < 3; c++) out[o + c] = (src[p00 + c] * (1 - fx) + src[p10 + c] * fx) * (1 - fy) + (src[p01 + c] * (1 - fx) + src[p11 + c] * fx) * fy;
        out[o + 3] = 255;
      }
    }
    return out;
  }

  /** 世界檔（.jgw）：像素大小、0、0、−像素大小、左上像素中心 E、N（CRLF，同範例） */
  function worldFileText(res, ulE, ulN) {
    var f = function (v) { return Number(v).toFixed(14).replace(/0+$/, '').replace(/\.$/, ''); };
    return [f(res), '0', '0', f(-res), f(ulE), f(ulN)].join('\r\n') + '\r\n';
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
    var out = { l2csv: [], raw2mac: [], csv2cntmac: [], coa2csv: [], dbf: [] };
    var cmap = {};
    var lmap = {};
    out.ignored = [];
    list.forEach(function (f) {
      var path = f.path || f.name;
      var ext = extName(f.name);
      var dir = path.indexOf('/') >= 0 ? path.slice(0, path.lastIndexOf('/')) : '';
      // KC0000.L02 每個資料夾都有（系統預設檔），略過；除非路徑裡有 KC0000 這個資料夾
      if (ext === 'L02' && baseName(f.name).toUpperCase() === 'KC0000' &&
          dir.split('/').map(function (x) { return x.toUpperCase(); }).indexOf('KC0000') < 0) {
        out.ignored.push(path);
        return;
      }
      if (L_TYPES[ext]) {
        var k = lGroupKey(path);
        if (!lmap[k]) {
          lmap[k] = { key: k, label: baseName(f.name), dir: dir, files: [], exts: [] };
          out.l2csv.push(lmap[k]);
        }
        lmap[k].files.push(f);
        lmap[k].exts.push(ext);
      }
      if (ext === 'D14' || ext === 'D20') out.dbf.push({ key: path, label: f.name, dir: dir, ext: ext, files: [f] });
      if (L_TYPES[ext]) {
        // 已處理
      } else if (COA_EXTS.indexOf(ext) >= 0) {
        var ck = lGroupKey(path);
        if (!cmap[ck]) {
          cmap[ck] = { key: ck, label: baseName(f.name), dir: dir, files: [], exts: [] };
          out.coa2csv.push(cmap[ck]);
        }
        cmap[ck].files.push(f);
        cmap[ck].exts.push(ext);
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
    out.coa2csv = out.coa2csv.filter(function (g) { return g.exts.indexOf('COA') >= 0; }).sort(byLabel);
    return out;
  }

  // ───────────────────────── 自動判斷 ─────────────────────────

  /** 依副檔名與內容猜測要用哪一種轉換。 */
  function detectKind(filename, text) {
    var ext = extName(filename);
    if (ext === 'RAW') return 'raw2mac';
    if (L_TYPES[ext]) return 'l2csv';
    if (ext === 'D14' || ext === 'D20') return 'dbf';
    if (COA_EXTS.indexOf(ext) >= 0) return 'coa2csv';
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
    L_ORDER: L_ORDER,
    classifyYX: classifyYX,
    isYVal: isYVal,
    isXVal: isXVal,
    coaToCsv: coaToCsv,
    writePoints: writePoints,
    lonLatToTwd97: lonLatToTwd97,
    twd97ToLonLat: twd97ToLonLat,
    lonLatToMercPx: lonLatToMercPx,
    BASEMAP_SOURCES: BASEMAP_SOURCES,
    pointsBBox: pointsBBox,
    splitClusters: splitClusters,
    basemapArea: basemapArea,
    shiftFromPairs: shiftFromPairs,
    suggestImagePairs: suggestImagePairs,
    imagePairsFromPoints: imagePairsFromPoints,
    planBasemap: planBasemap,
    basemapSampler: basemapSampler,
    worldFileText: worldFileText,
    resampleMercToTm2: resampleMercToTm2,
    parseDbf: parseDbf,
    appendDbf: appendDbf,
    planDbfWrite: planDbfWrite,
    buildDbfFiles: buildDbfFiles,
    knownFromDbf: knownFromDbf,
    parcelKeyOf: parcelKeyOf,
    COA_EXTS: COA_EXTS
  };
});
