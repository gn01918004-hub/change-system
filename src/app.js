/* 土地重測資料轉換系統 — 介面 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function el(tag, attrs, html) { var e = document.createElement(tag); if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); if (html != null) e.innerHTML = html; return e; }

  // ─────────── 各種轉換的說明文字 ───────────
  var KINDS = {
    raw2mac: {
      title: '全站儀觀測檔 → 重測系統',
      accept: '.raw,.txt',
      hint: '可一次放多個 .RAW 檔，每個檔會各自產生一個 .mac',
      step2: '檢查結果',
      next: function (r) {
        var s = [];
        var hasZero = r.files.some(function (f) { return /_Zero\.mac$/i.test(f.name); });
        if (hasZero) s.push('有測站的後視讀數不是 0，建議讀入 <b>_Zero.mac</b>（後視已歸零）；若重測系統會自己用後視觀測定向，則讀一般的 <b>.mac</b>。');
        else s.push('開啟土地重測系統，讀入剛剛存的 <b>.mac</b> 檔。');
        if (r.stats.freeStations) s.push('有自由測站：請先把「自由測站 .cnt」裡的坐標加入重測系統，再讀 .mac。');
        s.push('在重測系統裡檢查計算結果，點號後面的小數是編碼（例如 1001.01 = 點號 1001、編碼 01）。');
        return s;
      }
    },
    csv2cntmac: {
      title: 'GPS 坐標檔 → 重測系統',
      accept: '.csv,.txt,.asc',
      hint: 'GPS / VRS 控制器輸出的 .CSV，現場核對點、高程欄、雜點會自動整理',
      step2: '檢查點位',
      next: function () {
        return [
          '開啟土地重測系統，<b>先讀 .cnt 檔</b>（虛擬測站 99999 與後視點 99998 的坐標）。',
          '<b>再讀 .mac 檔</b>，系統會算出所有點的坐標。',
          '計算完成後，<b>刪除點號 99999 和 99998</b>（它們只是轉換用的虛擬點）。'
        ];
      }
    },
    l2csv: {
      title: '重測資料 → 外業儀器',
      accept: '.l02,.l14,.l20,.txt',
      hint: '同一案件的 .L02、.L14、.L20 會合併成一個檔；也可以直接選整個資料夾',
      step2: '檢查結果',
      next: function (r) {
        var dev = r.device === 'gps' ? 'GPS 控制器' : '全站儀';
        return [
          '把存好的檔案複製到隨身碟 / SD 卡，或用傳輸線傳到' + dev + '。',
          '在' + dev + '上選「匯入坐標」，格式選 <b>點號, ' + (r.swapXY ? '第2坐標, 第1坐標' : 'Y(N), X(E)') + '</b>（逗號分隔）。',
          '匯入後隨便抽查幾個點的坐標，確認沒有 X、Y 對調。'
        ];
      }
    }
  };

  // ─────────── 狀態 ───────────
  var state = { kind: null, device: 'ts', inputs: [], opts: loadOpts(), result: null, decisions: {}, reviewFilter: null };

  function loadOpts() {
    var d = { codeMode: 'pad2', sep: 'space', alwaysZero: false, codeColumn: 'auto', angleDecimals: 0, distDecimals: 3, swapXY: false, stripCode: false };
    try { var s = JSON.parse(localStorage.getItem('chsys-opts') || '{}'); for (var k in s) if (k in d) d[k] = s[k]; } catch (e) {}
    return d;
  }
  function saveOpts() {
    try { var o = {}; for (var k in state.opts) if (k !== 'outName') o[k] = state.opts[k]; localStorage.setItem('chsys-opts', JSON.stringify(o)); } catch (e) {}
  }

  // ─────────── 讀檔（自動判斷 UTF-8 / Big5） ───────────
  function decode(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { try { return new TextDecoder('big5').decode(buf); } catch (e2) { return new TextDecoder().decode(buf); } }
  }
  /** files：File 物件，或 { file, path } */
  function readFiles(list) {
    return Promise.all(Array.prototype.map.call(list, function (x) {
      var f = x.file || x;
      var path = x.path || f.webkitRelativePath || f.name;
      return f.arrayBuffer().then(function (b) { return { name: f.name, path: path, text: decode(b) }; });
    }));
  }
  function inputKey(f) { return f.path || f.name; }

  // ─────────── 畫面切換 ───────────
  function showHome() {
    $('toast').classList.add('hidden');
    state.kind = null; state.inputs = []; state.result = null; state.decisions = {};
    $('home').classList.remove('hidden'); $('work').classList.add('hidden');
    window.scrollTo(0, 0);
  }
  function openKind(kind, device) {
    state.kind = kind;
    if (device) state.device = device;
    state.inputs = []; state.result = null; state.opts.outName = ''; state.decisions = {}; state.reviewFilter = null;
    $('home').classList.add('hidden'); $('work').classList.remove('hidden');
    renderWork();
    window.scrollTo(0, 0);
  }
  function kindTitle() {
    if (state.kind === 'l2csv') return state.device === 'gps' ? '重測資料 → GPS 控制器' : '重測資料 → 全站儀';
    return KINDS[state.kind].title;
  }

  function setSteps(n) {
    Array.prototype.forEach.call($('steps').children, function (li) {
      var s = +li.getAttribute('data-s');
      li.className = s < n ? 'done' : (s === n ? 'now' : '');
      li.querySelector('.n').textContent = s < n ? '✓' : s;
    });
  }

  /** L 檔依案件（同資料夾、同主檔名）分組 */
  function lGroups(inputs) {
    var map = {}, list = [];
    inputs.forEach(function (f) {
      var k = Core.lGroupKey(inputKey(f));
      if (!map[k]) { map[k] = { key: k, label: Core.baseName(f.name), files: [] }; list.push(map[k]); }
      map[k].files.push(f);
    });
    return list;
  }

  function renderWork() {
    var K = KINDS[state.kind];
    $('workTitle').textContent = kindTitle();
    $('pickHint').textContent = K.hint;
    $('step2Label').textContent = K.step2;
    $('fileInput').setAttribute('accept', K.accept);
    var chips = $('chips'); chips.innerHTML = '';
    var addChip = function (label, title, onRemove) {
      var c = el('span', { 'class': 'chip', title: title }, esc(label) + ' ');
      var b = el('button', { title: '移除', 'aria-label': '移除 ' + label }, '×');
      b.onclick = onRemove;
      c.appendChild(b); chips.appendChild(c);
    };
    if (state.kind === 'l2csv') {
      lGroups(state.inputs).forEach(function (g) {
        var exts = g.files.map(function (f) { return Core.extName(f.name); }).join('、');
        addChip(g.label + '（' + exts + '）', g.files.map(inputKey).join('\n'), function () {
          state.inputs = state.inputs.filter(function (f) { return g.files.indexOf(f) < 0; }); run();
        });
      });
    } else {
      state.inputs.forEach(function (f, i) {
        addChip(f.name, inputKey(f), function () { state.inputs.splice(i, 1); run(); });
      });
    }
    $('pickBig').textContent = state.inputs.length ? '要換檔案或再加檔案？拖進來或點這裡' : '把檔案拖進來，或點這裡選擇';
    $('pickTitle').textContent = state.inputs.length ? '第 1 步：已放入 ' + state.inputs.length + ' 個檔案' : '第 1 步：放入檔案';
    if (!state.inputs.length) { $('resultArea').classList.add('hidden'); setSteps(1); }
  }

  // ─────────── 執行轉換 ───────────
  function run() {
    renderWork();
    if (!state.inputs.length) return;
    var o = state.opts, parts;
    if (state.kind === 'l2csv') {
      var groups = lGroups(state.inputs);
      parts = groups.map(function (g) {
        var x = Core.lToCsv(g.files, { device: state.device, swapXY: o.swapXY, stripCode: o.stripCode,
          outName: groups.length === 1 ? (o.outName || undefined) : undefined });
        x.source = g.label;
        return x;
      });
    } else {
      parts = state.inputs.map(function (inp) {
        var key = inputKey(inp);
        var opt = { codeMode: o.codeMode, sep: o.sep, alwaysZero: o.alwaysZero, codeCol: o.codeColumn,
          angleDecimals: o.angleDecimals, distDecimals: o.distDecimals, decisions: state.decisions[key] || {},
          outName: state.inputs.length === 1 ? (o.outName || undefined) : undefined };
        var x = state.kind === 'raw2mac' ? Core.rawToMac(inp.text, inp.name, opt) : Core.csvToCntMac(inp.text, inp.name, opt);
        x.source = inp.name;
        x.key = key;
        return x;
      });
    }
    var r = { kind: state.kind, device: state.device, swapXY: o.swapXY, files: [], report: [], parts: parts, stats: {} };
    parts.forEach(function (p) {
      r.files = r.files.concat(p.files);
      p.report.forEach(function (it) {
        r.report.push({ level: it.level, msg: (parts.length > 1 ? '【' + p.source + '】' : '') + it.msg, line: it.line });
      });
      for (var k in p.stats) if (typeof p.stats[k] === 'number') r.stats[k] = (r.stats[k] || 0) + p.stats[k];
    });
    if (state.kind === 'csv2cntmac') r.stats.maxErrMm = Math.max.apply(null, parts.map(function (p) { return p.stats.maxErrMm || 0; }));
    if (state.kind === 'l2csv') r.perFile = [].concat.apply([], parts.map(function (p) { return p.perFile; }));
    state.result = r;
    renderResult();
  }

  function count(r, lv) { return r.report.filter(function (x) { return x.level === lv; }).length; }

  function summaryText(r) {
    var s = r.stats;
    if (r.kind === 'raw2mac') {
      var t = '共 ' + (s.stations || 0) + ' 個測站、' + (s.observations || 0) + ' 筆觀測';
      if (s.nonZeroStations) t += '；其中 ' + s.nonZeroStations + ' 站後視不為 0';
      if (s.freeStations) t += '；自由測站 ' + s.freeStations + ' 個';
      return t;
    }
    if (r.kind === 'csv2cntmac') {
      var t2 = '轉換 ' + (s.points || 0) + ' 點';
      if (s.excluded) t2 += '（剔除 ' + s.excluded + ' 點）';
      if (s.maxErrMm != null && s.points) t2 += '；反算檢核最大誤差 ' + s.maxErrMm.toFixed(2) + ' mm';
      return t2;
    }
    if (r.parts.length > 1) return '共 ' + r.parts.length + ' 個案件、' + s.points + ' 個點（' + r.parts.map(function (p) { return p.source + ' ' + p.stats.points + ' 點'; }).join('、') + '）';
    return '共 ' + s.points + ' 個點（' + r.perFile.map(function (f) { return f.type + ' ' + f.count; }).join('、') + '）';
  }

  function renderResult() {
    var r = state.result;
    $('resultArea').classList.remove('hidden');
    var nErr = count(r, 'error'), nWarn = count(r, 'warn');
    var st = $('status');
    if (!r.files.length) {
      st.className = 'status err';
      st.innerHTML = '<div class="si">✕</div><div><div class="st">沒辦法轉換</div><div class="ss">請看下面紅色的錯誤說明，確認是不是放錯檔案。</div></div>';
      setSteps(r.kind === 'csv2cntmac' ? 2 : 1);
    } else if (nErr) {
      st.className = 'status warn';
      st.innerHTML = '<div class="si">!</div><div><div class="st">轉好了，但有 ' + nErr + ' 個錯誤要先檢查</div><div class="ss">' + esc(summaryText(r)) + '</div></div>';
      setSteps(2);
    } else if (nWarn) {
      st.className = 'status warn';
      st.innerHTML = '<div class="si">!</div><div><div class="st">轉換完成，有 ' + nWarn + ' 個地方請確認</div><div class="ss">' + esc(summaryText(r)) + '</div></div>';
      setSteps(3);
    } else {
      st.className = 'status ok';
      st.innerHTML = '<div class="si">✓</div><div><div class="st">轉換成功！</div><div class="ss">' + esc(summaryText(r)) + '</div></div>';
      setSteps(3);
    }

    renderThumbs(r);
    renderReview(r);

    // 檔案
    var fw = $('files'); fw.innerHTML = '';
    $('filesPanel').classList.toggle('hidden', !r.files.length);
    r.files.forEach(function (f) {
      var d = el('div', { 'class': 'file' + (f.recommended ? ' rec' : '') });
      var lines = f.content.split('\r\n').length - 1;
      d.innerHTML = '<div class="grow"><div class="fn">' + esc(f.name) + (f.recommended ? '<span class="badge rec">建議使用</span>' : '') + '</div>' +
        '<div class="fd">' + esc(f.desc || '') + '（' + lines + ' 行）</div></div>';
      var view = el('button', { 'class': 'btn small' }, '看內容');
      var dl = el('button', { 'class': 'btn go' }, '⬇ 下載');
      var pre = el('pre', { 'class': 'view hidden' });
      pre.textContent = f.content.length > 200000 ? f.content.slice(0, 200000) + '\n…（太長，只顯示前段）' : f.content;
      view.onclick = function () { pre.classList.toggle('hidden'); view.textContent = pre.classList.contains('hidden') ? '看內容' : '收起來'; };
      dl.onclick = function () { download(f); };
      d.appendChild(view); d.appendChild(dl); d.appendChild(pre);
      fw.appendChild(d);
    });
    var sa = $('saveAll'); sa.innerHTML = '';
    if (r.files.length > 1) {
      var all = el('button', { 'class': 'btn primary' }, '全部下載（' + r.files.length + ' 個）');
      all.onclick = function () { r.files.forEach(function (f, i) { setTimeout(function () { download(f, true); }, i * 400); }); toast('已開始下載 ' + r.files.length + ' 個檔案'); };
      sa.appendChild(all);
    }
    if (r.files.length && window.showDirectoryPicker) {
      var dir = el('button', { 'class': 'btn' }, '📁 全部存到指定資料夾…');
      dir.onclick = function () { saveToDir(r.files); };
      sa.appendChild(dir);
      sa.appendChild(el('span', { 'class': 'muted' }, '可以直接選擇要存放的資料夾（例如重測系統或隨身碟）'));
    }

    // 下一步
    var nx = $('next'); nx.innerHTML = '';
    $('nextPanel').classList.toggle('hidden', !r.files.length);
    KINDS[r.kind].next(r).forEach(function (t) { nx.appendChild(el('li', null, '<div>' + t + '</div>')); });

    // 問題清單
    var rp = $('report'); rp.innerHTML = '';
    var order = { error: 0, warn: 1, info: 2 };
    var items = r.report.slice().sort(function (a, b) { return order[a.level] - order[b.level]; });
    $('reportPanel').classList.toggle('hidden', !items.length);
    $('reportTitle').textContent = '需要注意的地方（' + items.length + '）';
    var LV = { error: '錯誤', warn: '注意', info: '說明' };
    items.forEach(function (it) {
      rp.appendChild(el('li', { 'class': it.level }, '<span class="lv">' + LV[it.level] + '</span><span>' + esc(it.msg) +
        (it.line ? ' <span class="ln">（原檔第 ' + it.line + ' 行）</span>' : '') + '</span>'));
    });

    renderPreview(r);
    renderOpts();
  }

  // ═════════════ 縮圖 ═════════════

  var STYLE = {
    ok: { fill: '#1f6feb', r: 1 },
    flag: { fill: '#e08a00', r: 1.15 },
    off: { fill: 'none', stroke: '#c62828', r: 1.1 },
    station: { fill: '#11845b', tri: true, r: 1.9 },
    known: { fill: '#16324f', sq: true, r: 1.1 },
    obs: { fill: '#1f6feb', r: 1 },
    ctl: { fill: '#c62828', tri: true, r: 1.6 },
    bnd: { fill: '#1f6feb', r: 1 },
    add: { fill: '#11845b', r: 1.1 },
    other: { fill: '#6b7785', r: 1 }
  };
  var LEGENDS = {
    csv2cntmac: [['ok', '要轉換'], ['flag', '要轉換但有疑慮'], ['off', '剔除（不轉換）'], ['station', '虛擬測站 / 後視']],
    raw2mac: [['station', '測站'], ['known', '檔案內已知點'], ['obs', '觀測點（推算位置）']],
    l2csv: [['ctl', '控制點 L02'], ['bnd', '界址點/參考點 L14'], ['add', '補點 L20']]
  };

  /** 把一個 part 轉成要畫的點：{ N, E, name, cls, line } */
  function plotData(r, p, showAll) {
    if (r.kind === 'csv2cntmac') {
      var roles = {};
      p.preview.forEach(function (x) { if (x.role) roles[x.line] = x.role; });
      var pts = p.points.filter(function (q) { return isFinite(q.N) && isFinite(q.E) && q.N !== 0 && q.E !== 0; }).map(function (q) {
        var cls = !q.include ? 'off' : (roles[q.line] ? 'station' : (q.flags.length ? 'flag' : 'ok'));
        return { N: q.N, E: q.E, name: q.name, cls: cls, line: q.line, tip: q.name + (q.reasons.length ? '：' + q.reasons.join('、') : '') + (q.include ? '' : '（剔除）') };
      });
      var inc = pts.filter(function (q) { return q.cls !== 'off'; });
      return { pts: pts, bbox: showAll || !inc.length ? pts : inc, rays: [] };
    }
    if (r.kind === 'raw2mac') {
      var pl = p.plot || { points: [], rays: [] };
      var pts2 = pl.points.map(function (q) { return { N: q.N, E: q.E, name: q.name, cls: q.kind, tip: q.name }; });
      // 畫面以測站、後視與觀測點為主，太遠的已知點不必擠進來（勾選「顯示全部」才看）
      var focus = pl.focus || {};
      var fb = pts2.filter(function (q) { return q.cls === 'obs' || focus[q.name]; });
      return { pts: pts2, bbox: showAll || !fb.length ? pts2 : fb, rays: pl.rays };
    }
    var map = { '控制點': 'ctl', '界址點/參考點': 'bnd', '補點': 'add' };
    var pts3 = p.preview.map(function (q) {
      return { N: parseFloat(q.y), E: parseFloat(q.x), name: q.name, cls: map[q.type] || 'other', tip: q.name + '（' + q.type + '）' };
    }).filter(function (q) { return isFinite(q.N) && isFinite(q.E); });
    return { pts: pts3, bbox: pts3, rays: [] };
  }

  function plotSvg(data, w, h, o) {
    o = o || {};
    var pad = o.big ? 28 : 10;
    var bb = data.bbox.length ? data.bbox : data.pts;
    if (!bb.length) return '<svg viewBox="0 0 ' + w + ' ' + h + '"><text x="' + (w / 2) + '" y="' + (h / 2) + '" text-anchor="middle" fill="#8a96a3" font-size="13">沒有可畫的點</text></svg>';
    var minN = Infinity, maxN = -Infinity, minE = Infinity, maxE = -Infinity;
    bb.forEach(function (q) { minN = Math.min(minN, q.N); maxN = Math.max(maxN, q.N); minE = Math.min(minE, q.E); maxE = Math.max(maxE, q.E); });
    var dN = Math.max(maxN - minN, 1e-6), dE = Math.max(maxE - minE, 1e-6);
    var s = Math.min((w - 2 * pad) / dE, (h - 2 * pad) / dN);
    if (!isFinite(s) || s > 1e6) s = 1;
    var ox = (w - dE * s) / 2, oy = (h - dN * s) / 2;
    var X = function (E) { return ox + (E - minE) * s; };
    var Y = function (N) { return h - oy - (N - minN) * s; };
    var base = o.big ? 4.2 : 2.6;
    var out = ['<svg viewBox="0 0 ' + w + ' ' + h + '" xmlns="http://www.w3.org/2000/svg" role="img">'];
    // 比例尺
    var scaleM = niceLen((w - 2 * pad) / s / 4);
    var sx = pad, sy = h - 8;
    out.push('<g stroke="#8a96a3" stroke-width="1.2"><line x1="' + sx + '" y1="' + sy + '" x2="' + (sx + scaleM * s) + '" y2="' + sy + '"/><line x1="' + sx + '" y1="' + (sy - 3) + '" x2="' + sx + '" y2="' + (sy + 1) + '"/><line x1="' + (sx + scaleM * s) + '" y1="' + (sy - 3) + '" x2="' + (sx + scaleM * s) + '" y2="' + (sy + 1) + '"/></g>');
    out.push('<text x="' + (sx + scaleM * s + 4) + '" y="' + (sy + 3) + '" font-size="' + (o.big ? 12 : 10) + '" fill="#8a96a3">' + fmtLen(scaleM) + '</text>');
    // 北
    var nx = w - 14, ny = 8;
    out.push('<g fill="#8a96a3"><path d="M' + nx + ' ' + ny + ' l-4 10 h8 z"/><text x="' + nx + '" y="' + (ny + 22) + '" font-size="10" text-anchor="middle">N</text></g>');
    // 射線
    if (data.rays.length) {
      out.push('<g stroke="#9fb3c8" stroke-width="' + (o.big ? 0.8 : 0.5) + '" opacity=".7">');
      data.rays.forEach(function (ry) { out.push('<line x1="' + X(ry.E1).toFixed(1) + '" y1="' + Y(ry.N1).toFixed(1) + '" x2="' + X(ry.E2).toFixed(1) + '" y2="' + Y(ry.N2).toFixed(1) + '"/>'); });
      out.push('</g>');
    }
    var order = ['off', 'other', 'bnd', 'add', 'obs', 'ok', 'flag', 'known', 'ctl', 'station'];
    var sorted = data.pts.slice().sort(function (a, b) { return order.indexOf(a.cls) - order.indexOf(b.cls); });
    var showLabels = o.big && data.pts.length <= 400;
    sorted.forEach(function (q) {
      var x = X(q.E), y = Y(q.N);
      if (x < -20 || x > w + 20 || y < -20 || y > h + 20) return;
      var st = STYLE[q.cls] || STYLE.other;
      var r = base * st.r;
      var attrs = 'class="pt' + (o.clickable && q.line ? ' click' : '') + '"' + (q.line ? ' data-line="' + q.line + '"' : '');
      var paint = st.fill === 'none' ? 'fill="#fff" stroke="' + st.stroke + '" stroke-width="' + (o.big ? 1.6 : 1.2) + '"' : 'fill="' + st.fill + '" stroke="#fff" stroke-width="' + (o.big ? 0.8 : 0.5) + '"';
      var shape;
      if (st.tri) shape = '<path ' + attrs + ' ' + paint + ' d="M' + x.toFixed(1) + ' ' + (y - r * 1.2).toFixed(1) + ' l' + r + ' ' + (r * 2).toFixed(1) + ' h' + (-2 * r).toFixed(1) + ' z">';
      else if (st.sq) shape = '<rect ' + attrs + ' ' + paint + ' x="' + (x - r).toFixed(1) + '" y="' + (y - r).toFixed(1) + '" width="' + (2 * r).toFixed(1) + '" height="' + (2 * r).toFixed(1) + '">';
      else shape = '<circle ' + attrs + ' ' + paint + ' cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(1) + '">';
      var tag = st.tri ? 'path' : (st.sq ? 'rect' : 'circle');
      out.push(shape + '<title>' + esc(q.tip || q.name) + '</title></' + tag + '>');
      if (showLabels) out.push('<text x="' + (x + r + 2).toFixed(1) + '" y="' + (y - r).toFixed(1) + '" font-size="11" fill="#4a5664" pointer-events="none">' + esc(q.name) + '</text>');
    });
    out.push('</svg>');
    return out.join('');
  }
  function niceLen(v) {
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / p;
    return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
  }
  function fmtLen(m) { return m >= 1000 ? (m / 1000) + ' km' : (m >= 1 ? m + ' m' : (m * 100).toFixed(0) + ' cm'); }

  function partCaption(r, p) {
    if (r.kind === 'csv2cntmac') return p.stats.points + ' 點' + (p.stats.excluded ? '・剔除 ' + p.stats.excluded : '');
    if (r.kind === 'raw2mac') return p.stats.stations + ' 站・' + p.stats.observations + ' 點';
    return p.stats.points + ' 點';
  }

  function renderThumbs(r) {
    var box = $('thumbs'); box.innerHTML = '';
    var any = false;
    r.parts.forEach(function (p, i) {
      var data = plotData(r, p, false);
      if (!data.pts.length) return;
      any = true;
      var b = el('button', { 'class': 'thumb', type: 'button', title: '點一下放大' });
      b.innerHTML = plotSvg(data, 244, 172) + '<div class="cap"><b>' + esc(p.source) + '</b><span>' + esc(partCaption(r, p)) + '</span></div>';
      b.onclick = function () { openPlot(i); };
      box.appendChild(b);
    });
    if (r.kind === 'raw2mac' && !any) {
      box.innerHTML = '<div class="muted">這個 RAW 檔裡沒有測站的已知坐標（UP 紀錄），無法畫出點位縮圖。</div>';
      any = true;
    }
    $('thumbPanel').classList.toggle('hidden', !any);
  }

  var plotShowAll = false;
  function openPlot(i) {
    var r = state.result, p = r.parts[i];
    if (!p) return;
    var data = plotData(r, p, plotShowAll);
    var isCsv = r.kind === 'csv2cntmac';
    var canAll = isCsv || r.kind === 'raw2mac';
    var legend = '<div class="legend">' + LEGENDS[r.kind].map(function (l) {
      var st = STYLE[l[0]];
      return '<span><i style="' + (st.fill === 'none' ? 'border:2px solid ' + st.stroke : 'background:' + st.fill) + (st.tri || st.sq ? ';border-radius:2px' : '') + '"></i>' + l[1] + '</span>';
    }).join('') + '</div>';
    var bar = '<div class="plotbar"><div>' + legend + '</div>' +
      (canAll ? '<label class="muted" style="cursor:pointer"><input type="checkbox" id="plotAll" ' + (plotShowAll ? 'checked' : '') + '> ' + (isCsv ? '畫面包含剔除的點（可能離很遠）' : '畫面包含所有已知點') + '</label>' : '') + '</div>';
    modal('<h3>' + esc(p.source) + ' <span class="muted">' + esc(partCaption(r, p)) + '</span></h3>' + bar +
      '<div class="bigplot">' + plotSvg(data, 900, 600, { big: true, clickable: isCsv }) + '</div>' +
      '<div class="muted" style="margin-top:8px">' + (isCsv ? '把滑鼠移到點上可看點名；<b>點一下可切換「轉換 / 剔除」</b>。' : '把滑鼠移到點上可看點名。') +
      (r.kind === 'raw2mac' ? ' 觀測點位置是用檔案內已知坐標推算的大略位置，只供檢查用。' : '') + '</div>' +
      '<div style="text-align:right;margin-top:12px"><button class="btn primary" id="closePlot">關閉</button></div>', true);
    $('closePlot').onclick = closeModal;
    if (canAll) $('plotAll').onchange = function () { plotShowAll = this.checked; openPlot(i); };
    if (isCsv) {
      Array.prototype.forEach.call($('modalBox').querySelectorAll('.pt.click'), function (c) {
        c.addEventListener('click', function () {
          var line = +c.getAttribute('data-line');
          var q = p.points.filter(function (x) { return x.line === line; })[0];
          if (!q) return;
          setDecision(p.key, line, !q.include);
          openPlot(i);
        });
      });
    }
  }

  // ═════════════ GPS 點位檢查 ═════════════

  function setDecision(key, line, include) {
    var d = state.decisions[key] = state.decisions[key] || {};
    d[line] = include;
    run();
  }

  var REVIEW_MAX = 800;
  function renderReview(r) {
    var panel = $('reviewPanel');
    if (r.kind !== 'csv2cntmac') { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    var all = [].concat.apply([], r.parts.map(function (p) { return p.points.map(function (q) { return { p: p, q: q }; }); }));
    var nFlag = all.filter(function (x) { return x.q.flags.length; }).length;
    var nInc = all.filter(function (x) { return x.q.include; }).length;
    var nOff = all.length - nInc;
    if (!state.reviewFilter) state.reviewFilter = nFlag ? 'flag' : 'all';
    var f = state.reviewFilter;
    var list = all.filter(function (x) {
      return f === 'all' || (f === 'flag' && x.q.flags.length) || (f === 'in' && x.q.include) || (f === 'out' && !x.q.include);
    });

    var cols = r.parts[0].cols || {};
    var h = '<p class="sum">檔案裡共 <b>' + all.length + '</b> 點：會轉換 <b style="color:var(--ok)">' + nInc + '</b> 點、剔除 <b style="color:var(--err)">' + nOff + '</b> 點' +
      (nFlag ? '；其中 <b>' + nFlag + '</b> 點系統覺得有疑慮（已先幫你決定，可以改）' : '；沒有發現可疑的點') + '。</p>' +
      '<p class="muted" style="margin:-4px 0 10px">欄位判斷：第 1 欄點名、第 2 欄 N、第 3 欄 E' +
      (cols.h >= 0 ? '、第 ' + (cols.h + 1) + ' 欄高程（不轉換）' : '') + (cols.code >= 0 ? '、第 ' + (cols.code + 1) + ' 欄編碼' : '、沒有編碼欄') + '。不對的話到「進階設定」改。</p>';
    h += '<div class="bar"><div class="seg" id="rvFilter">' +
      [['flag', '有疑慮的 (' + nFlag + ')'], ['out', '剔除的 (' + nOff + ')'], ['in', '會轉換的 (' + nInc + ')'], ['all', '全部 (' + all.length + ')']].map(function (b) {
        return '<button type="button" data-f="' + b[0] + '" class="' + (f === b[0] ? 'on' : '') + '">' + b[1] + '</button>';
      }).join('') + '</div>' +
      '<button class="btn small" id="rvReset" type="button">恢復系統建議</button>' +
      '<button class="btn small" id="rvShownIn" type="button">目前列出的全部轉換</button>' +
      '<button class="btn small" id="rvShownOut" type="button">目前列出的全部剔除</button></div>';
    if (!list.length) {
      h += '<div class="muted" style="padding:10px">這個分類沒有點。</div>';
    } else {
      h += '<div class="tablewrap"><table><thead><tr><th class="c">轉換</th><th class="l">點名</th><th>N</th><th>E</th>' +
        (cols.h >= 0 ? '<th>高程</th>' : '') + '<th>編碼</th><th class="l">狀態</th><th>原檔行</th></tr></thead><tbody>';
      var lastSrc = null;
      list.slice(0, REVIEW_MAX).forEach(function (x) {
        var q = x.q;
        if (r.parts.length > 1 && x.p.source !== lastSrc) { lastSrc = x.p.source; h += '<tr class="station"><td class="l" colspan="8">' + esc(lastSrc) + '</td></tr>'; }
        var badges = q.flags.length ? q.reasons.map(function (t, k) {
          var hard = { junk: 1, check: 1, far: 1, dup: 1 }[q.flags[k]];
          return '<span class="flagb ' + (hard ? 'x' : 'w') + '">' + esc(t) + '</span>';
        }).join('') : '<span class="flagb ok">正常</span>';
        h += '<tr class="' + (q.include ? '' : 'off') + '"><td class="c"><input type="checkbox" data-key="' + esc(x.p.key) + '" data-line="' + q.line + '" ' + (q.include ? 'checked' : '') + ' aria-label="轉換 ' + esc(q.name) + '"></td>' +
          '<td class="l mono">' + esc(q.name || '（無）') + '</td><td class="mono">' + esc(q.n) + '</td><td class="mono">' + esc(q.e) + '</td>' +
          (cols.h >= 0 ? '<td class="mono">' + esc(q.h) + '</td>' : '') + '<td class="mono">' + esc(q.code) + '</td><td class="l">' + badges + '</td><td>' + q.line + '</td></tr>';
      });
      h += '</tbody></table></div>';
      if (list.length > REVIEW_MAX) h += '<div class="muted" style="padding:8px">只列出前 ' + REVIEW_MAX + ' 點，共 ' + list.length + ' 點。</div>';
    }
    $('review').innerHTML = h;

    Array.prototype.forEach.call($('rvFilter').querySelectorAll('button'), function (b) {
      b.onclick = function () { state.reviewFilter = b.getAttribute('data-f'); renderReview(state.result); };
    });
    Array.prototype.forEach.call($('review').querySelectorAll('input[type=checkbox][data-line]'), function (c) {
      c.onchange = function () { setDecision(c.getAttribute('data-key'), +c.getAttribute('data-line'), c.checked); };
    });
    $('rvReset').onclick = function () { state.decisions = {}; run(); };
    var bulk = function (inc) {
      list.forEach(function (x) { var d = state.decisions[x.p.key] = state.decisions[x.p.key] || {}; d[x.q.line] = inc; });
      run();
    };
    $('rvShownIn').onclick = function () { bulk(true); };
    $('rvShownOut').onclick = function () { bulk(false); };
  }

  // ═════════════ 資料表預覽 ═════════════

  var MAX_ROWS = 500;
  function renderPreview(r) {
    var h = '', rows = 0, total = 0;
    if (r.kind === 'raw2mac') {
      var zero = r.stats.nonZeroStations > 0;
      h = '<table><thead><tr><th class="l">點號</th><th>水平角</th>' + (zero ? '<th>歸零後水平角</th>' : '') + '<th>天頂角</th><th>斜距</th><th>原檔行</th></tr></thead><tbody>';
      r.parts.forEach(function (p) {
        var last = null;
        p.preview.forEach(function (x) {
          total++;
          if (rows >= MAX_ROWS) return;
          var key = x.station + '|' + x.back + '|' + p.source;
          if (key !== last) { h += '<tr class="station"><td class="l" colspan="' + (zero ? 6 : 5) + '">' + (r.parts.length > 1 ? esc(p.source) + '　' : '') + '測站 ' + esc(x.station) + '　後視 ' + esc(x.back) + '</td></tr>'; last = key; }
          h += '<tr><td class="l mono">' + esc(x.name) + '</td><td class="mono">' + esc(x.ha) + '</td>' +
            (zero ? '<td class="mono' + (x.ha0 !== x.ha ? ' hl' : '') + '">' + esc(x.ha0) + '</td>' : '') +
            '<td class="mono">' + esc(x.va) + '</td><td class="mono">' + esc(x.sd) + '</td><td>' + x.line + '</td></tr>';
          rows++;
        });
      });
      h += '</tbody></table>';
      if (r.parts.some(function (p) { return p.freeStations.length; })) {
        h += '<div style="padding:10px"><b>自由測站坐標</b>（請自行加入重測系統）<table><thead><tr><th class="l">點號</th><th>N</th><th>E</th></tr></thead><tbody>';
        r.parts.forEach(function (p) { p.freeStations.forEach(function (f) { h += '<tr><td class="l mono">' + esc(f.name) + '</td><td class="mono">' + esc(f.n) + '</td><td class="mono">' + esc(f.e) + '</td></tr>'; }); });
        h += '</tbody></table></div>';
      }
    } else if (r.kind === 'csv2cntmac') {
      h = '<table><thead><tr><th class="l">點號</th><th>N</th><th>E</th><th>角度（度.分秒）</th><th>水平距離</th><th>反算誤差 mm</th></tr></thead><tbody>';
      r.parts.forEach(function (p) {
        if (r.parts.length > 1) h += '<tr class="station"><td class="l" colspan="6">' + esc(p.source) + '</td></tr>';
        p.preview.forEach(function (x) {
          total++;
          if (rows >= MAX_ROWS) return;
          var tag = x.role === 'station' ? '（測站 99999）' : (x.role === 'backsight' ? '（後視 99998）' : '');
          h += '<tr><td class="l mono">' + esc(x.name) + ' <span class="muted">' + tag + '</span></td><td class="mono">' + esc(x.n) + '</td><td class="mono">' + esc(x.e) + '</td><td class="mono">' + esc(x.ang) + '</td><td class="mono">' + esc(x.dist) + '</td><td class="' + (x.errMm > 2 ? 'bad' : '') + '">' + x.errMm.toFixed(2) + '</td></tr>';
          rows++;
        });
      });
      h += '</tbody></table>';
    } else {
      var sw = r.swapXY;
      h = '<table><thead><tr><th class="l">點號</th><th>' + (sw ? '第 2 坐標' : 'Y') + '</th><th>' + (sw ? '第 1 坐標' : 'X') + '</th><th class="l">種類</th><th class="l">來源檔案</th></tr></thead><tbody>';
      r.parts.forEach(function (part) {
        if (r.parts.length > 1) h += '<tr class="station"><td class="l" colspan="5">' + esc(part.source) + '</td></tr>';
        part.preview.forEach(function (p) {
          total++;
          if (rows >= MAX_ROWS) return;
          h += '<tr><td class="l mono">' + esc(p.name) + '</td><td class="mono">' + esc(sw ? p.x : p.y) + '</td><td class="mono">' + esc(sw ? p.y : p.x) + '</td><td class="l">' + esc(p.type) + '</td><td class="l">' + esc(p.src) + '</td></tr>';
          rows++;
        });
      });
      h += '</tbody></table>';
    }
    if (total > MAX_ROWS) h += '<div class="muted" style="padding:8px 10px">只顯示前 ' + MAX_ROWS + ' 筆，共 ' + total + ' 筆（檔案裡是完整的）。</div>';
    $('preview').innerHTML = h;
    $('previewTitle').textContent = '看轉換後的資料表（' + total + ' 筆）';
  }

  // ─────────── 進階設定 ───────────
  function seg(label, key, choices, hint) {
    var w = el('div', { 'class': 'opt' });
    w.appendChild(el('label', { 'class': 'h' }, esc(label)));
    var s = el('div', { 'class': 'seg' });
    choices.forEach(function (c) {
      var b = el('button', { type: 'button', 'class': state.opts[key] === c[0] ? 'on' : '' }, esc(c[1]));
      b.onclick = function () { state.opts[key] = c[0]; saveOpts(); if (key === 'codeColumn') state.decisions = {}; run(); };
      s.appendChild(b);
    });
    w.appendChild(s);
    if (hint) w.appendChild(el('div', { 'class': 'hint' }, hint));
    return w;
  }
  function chk(label, key, hint) {
    var w = el('div', { 'class': 'opt' });
    var l = el('label', { 'class': 'chk' });
    var i = el('input', { type: 'checkbox' }); i.checked = !!state.opts[key];
    i.onchange = function () { state.opts[key] = i.checked; saveOpts(); run(); };
    l.appendChild(i); l.appendChild(el('span', null, '<b>' + esc(label) + '</b>' + (hint ? '<div class="hint">' + hint + '</div>' : '')));
    w.appendChild(l);
    return w;
  }
  function renderOpts() {
    var o = $('opts'); o.innerHTML = '';
    var k = state.kind;
    var single = k === 'l2csv' ? lGroups(state.inputs).length === 1 : state.inputs.length === 1;
    if (single) {
      var w = el('div', { 'class': 'opt' });
      w.appendChild(el('label', { 'class': 'h', 'for': 'outName' }, '輸出檔名（不含副檔名）'));
      var inp = el('input', { type: 'text', id: 'outName', placeholder: '預設跟原檔同名' });
      inp.value = state.opts.outName || '';
      inp.onchange = function () { state.opts.outName = inp.value.trim(); run(); };
      w.appendChild(inp);
      o.appendChild(w);
    }
    if (k === 'raw2mac' || k === 'csv2cntmac') {
      o.appendChild(seg('點號編碼格式', 'codeMode', [['pad2', '補兩位 1001.05'], ['raw', '照原樣 1001.5']],
        '重測系統的「點號.編碼」。舊 Excel 版是補兩位，舊 jar 版是照原樣。'));
      o.appendChild(seg('欄位分隔', 'sep', [['space', '空白'], ['tab', 'Tab']], '重測系統兩種都能讀，通常不用改。'));
    }
    if (k === 'raw2mac') {
      o.appendChild(chk('一律輸出後視歸零檔（_Zero.mac）', 'alwaysZero', '預設只有在後視讀數不為 0 時才會產生。'));
    }
    if (k === 'csv2cntmac') {
      var maxCols = Math.max.apply(null, (state.result && state.result.parts || []).map(function (p) { return p.maxCols || 4; }).concat([4]));
      var ch = [['auto', '自動判斷'], [0, '沒有編碼']];
      for (var c = 4; c <= Math.min(maxCols, 7); c++) ch.push([c, '第 ' + c + ' 欄']);
      o.appendChild(seg('編碼（CD 碼）在第幾欄', 'codeColumn', ch, '第 1 欄點名、第 2 欄 N、第 3 欄 E。控制器原始檔通常是「點名,N,E,高程,編碼」，編碼在第 5 欄。'));
      o.appendChild(seg('角度秒數的小數位', 'angleDecimals', [[0, '整數秒'], [1, '1 位'], [2, '2 位']],
        '整數秒與舊 Excel 版相同。反算誤差太大時可改 1 位（需確認重測系統可讀）。'));
      o.appendChild(seg('距離小數位', 'distDecimals', [[3, '3 位 (mm)'], [4, '4 位']]));
    }
    if (k === 'l2csv') {
      var dev = el('div', { 'class': 'opt' });
      dev.appendChild(el('label', { 'class': 'h' }, '要給哪種儀器'));
      var s = el('div', { 'class': 'seg' });
      [['ts', '全站儀'], ['gps', 'GPS 控制器']].forEach(function (c) {
        var b = el('button', { type: 'button', 'class': state.device === c[0] ? 'on' : '' }, c[1]);
        b.onclick = function () { state.device = c[0]; run(); };
        s.appendChild(b);
      });
      dev.appendChild(s);
      dev.appendChild(el('div', { 'class': 'hint' }, '全站儀：界址→補點→控制點順序、副檔名 .CSV；GPS：控制點→界址→補點順序、副檔名 .csv。'));
      o.appendChild(dev);
      o.appendChild(chk('交換坐標欄位順序', 'swapXY', '儀器匯入後如果點位 X、Y 顛倒，勾這個。'));
      o.appendChild(chk('去掉點號後面的編碼', 'stripCode', '例如 1001.05 → 1001（.0、.00 一律會自動去掉）。'));
    }
  }

  // ─────────── 存檔 ───────────
  function blobOf(f) { return new Blob([f.content], { type: 'text/plain' }); }
  function download(f, silent) {
    var a = el('a', { href: URL.createObjectURL(blobOf(f)), download: f.name });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    if (!silent) toast('已下載 ' + f.name + '（在瀏覽器的「下載」資料夾）');
  }
  function saveToDir(files) {
    window.showDirectoryPicker({ mode: 'readwrite' }).then(function (dir) {
      return files.reduce(function (p, f) {
        return p.then(function () {
          return dir.getFileHandle(f.name, { create: true }).then(function (h) {
            return h.createWritable().then(function (w) { return w.write(blobOf(f)).then(function () { return w.close(); }); });
          });
        });
      }, Promise.resolve()).then(function () { toast('已存好 ' + files.length + ' 個檔案到「' + dir.name + '」'); });
    }).catch(function (e) { if (e && e.name !== 'AbortError') toast('存檔失敗：' + e.message); });
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 3200);
  }

  // ─────────── 對話框 ───────────
  function modal(html, wide) {
    $('modalBox').innerHTML = html;
    $('modalBox').style.maxWidth = wide ? '980px' : '';
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  function startL2csv(files, device) {
    closeModal();
    if (state.kind !== 'l2csv') openKind('l2csv', device);
    else if (device) state.device = device;
    mergeInputs(files);
    run();
  }

  function askDevice(files) {
    modal('<h3>這些重測資料要給哪種儀器？</h3><div class="muted">已讀到：' + files.map(function (f) { return esc(f.name); }).join('、') + '</div>' +
      '<div class="choice"><button data-d="ts">全站儀<small>Nikon 等全站儀放樣</small></button><button data-d="gps">GPS 控制器<small>Trimble 等 GPS 控制器</small></button></div>');
    Array.prototype.forEach.call($('modalBox').querySelectorAll('[data-d]'), function (b) {
      b.onclick = function () { startL2csv(files, b.getAttribute('data-d')); };
    });
  }

  $('btnAbout').onclick = function () {
    modal('<div class="about"><h3>使用說明</h3>' +
      '<p>三個步驟：<b>① 放入檔案（或選整個資料夾）→ ② 看縮圖和紅色/黃色提醒 → ③ 按綠色「下載」</b>。檔案只在你的電腦上處理，不會上傳。</p>' +
      '<table><thead><tr><th>功能</th><th>放入</th><th>得到</th></tr></thead><tbody>' +
      '<tr><td>全站儀 → 重測系統</td><td>Nikon .RAW</td><td>.mac（必要時加 _Zero.mac）</td></tr>' +
      '<tr><td>GPS → 重測系統</td><td>控制器輸出的 .CSV（會自動剔除核對點、雜點）</td><td>.cnt ＋ .mac ＋ 整理後的 .csv</td></tr>' +
      '<tr><td>重測 → 全站儀 / GPS</td><td>.L02 .L14 .L20（同案件自動合併）</td><td>.csv（點號,Y,X）</td></tr></tbody></table>' +
      '<p class="muted">整合自：RawToMACV2.0.jar、NIKON轉MAC 0714F5.xls、CSV TO 重測 CT02.xls、TrimblePointInputV3.jar、重測轉CSV TS01.xls。</p>' +
      '<div style="text-align:right;margin-top:14px"><button class="btn primary" id="closeAbout">知道了</button></div></div>');
    $('closeAbout').onclick = closeModal;
  };

  // ═════════════ 選資料夾 ═════════════

  /** 從資料夾挑檔案：依種類分組讓使用者勾選。entries：[{ file, path }] */
  function handleFolder(entries, folderName) {
    var list = entries.map(function (x) { return { name: x.file.name, path: x.path, file: x.file }; });
    var g = Core.groupFolderFiles(list);
    var kinds = state.kind ? [state.kind] : ['l2csv', 'raw2mac', 'csv2cntmac'];
    var total = kinds.reduce(function (n, k) { return n + g[k].length; }, 0);
    if (!total) {
      modal('<h3>資料夾裡沒有找到可以轉換的檔案</h3><p class="muted">「' + esc(folderName) + '」裡共 ' + entries.length + ' 個檔案，沒有 ' +
        (state.kind === 'l2csv' ? '.L02 / .L14 / .L20' : state.kind === 'raw2mac' ? '.RAW' : state.kind === 'csv2cntmac' ? '.CSV' : '.RAW、.CSV、.L02 / .L14 / .L20') + '。</p>' +
        '<div style="text-align:right"><button class="btn primary" id="ok1">好</button></div>');
      $('ok1').onclick = closeModal;
      return;
    }
    // 只有一項：直接開始
    if (total === 1) {
      var k1 = kinds.filter(function (k) { return g[k].length; })[0];
      loadGroups([g[k1][0]], k1, null);
      return;
    }
    var TITLES = { l2csv: '重測資料（同案件的 L02、L14、L20 合併成一個檔）', raw2mac: '全站儀觀測檔 .RAW', csv2cntmac: 'GPS 坐標檔 .CSV' };
    var h = '<h3>在「' + esc(folderName) + '」找到這些資料</h3><div class="muted">勾選要轉換的項目（可以多選），再按下面的按鈕。</div>';
    kinds.forEach(function (k) {
      if (!g[k].length) return;
      h += '<div class="fsec" data-k="' + k + '"><h4><span>' + TITLES[k] + '</span><label class="muted" style="font-size:14px;cursor:pointer;font-weight:400"><input type="checkbox" class="selall"> 全選</label></h4>';
      g[k].forEach(function (item, i) {
        var det;
        if (k === 'l2csv') {
          det = ['L02', 'L14', 'L20'].map(function (e) {
            return '<span class="extb' + (item.exts.indexOf(e) < 0 ? ' miss' : '') + '">' + e + '</span>';
          }).join('') + ' ' + ['控制點', '界址/參考點', '補點'].filter(function (t, j) { return item.exts.indexOf(['L02', 'L14', 'L20'][j]) >= 0; }).join('、');
        } else det = '';
        h += '<label class="item"><input type="checkbox" data-i="' + i + '"' + (g[k].length === 1 ? ' checked' : '') + '><span><b>' + esc(item.label) + '</b>' +
          (det ? '<div class="det">' + det + '</div>' : '') + (item.dir ? '<div class="det">📁 ' + esc(item.dir) + '</div>' : '') + '</span></label>';
      });
      h += '<div class="acts">';
      if (k === 'l2csv' && !state.kind) {
        h += '<button class="btn primary go-btn" data-d="ts" disabled>轉給全站儀 →</button><button class="btn primary go-btn" data-d="gps" disabled>轉給 GPS 控制器 →</button>';
      } else {
        h += '<button class="btn primary go-btn" disabled>轉換勾選的項目 →</button>';
      }
      h += '</div></div>';
    });
    h += '<div style="text-align:right;margin-top:14px"><button class="btn" id="fCancel">取消</button></div>';
    modal(h);
    $('fCancel').onclick = closeModal;
    Array.prototype.forEach.call($('modalBox').querySelectorAll('.fsec'), function (sec) {
      var k = sec.getAttribute('data-k');
      var boxes = sec.querySelectorAll('input[data-i]');
      var btns = sec.querySelectorAll('.go-btn');
      var refresh = function () {
        var n = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).length;
        Array.prototype.forEach.call(btns, function (b) {
          b.disabled = !n;
          b.textContent = b.textContent.replace(/（\d+ 項）/, '').replace(' →', '') + (n ? '（' + n + ' 項）' : '') + ' →';
        });
        sec.querySelector('.selall').checked = n === boxes.length;
      };
      Array.prototype.forEach.call(boxes, function (b) { b.onchange = refresh; });
      sec.querySelector('.selall').onchange = function () {
        var v = this.checked;
        Array.prototype.forEach.call(boxes, function (b) { b.checked = v; });
        refresh();
      };
      Array.prototype.forEach.call(btns, function (btn) {
        btn.onclick = function () {
          var picked = Array.prototype.filter.call(boxes, function (b) { return b.checked; }).map(function (b) { return g[k][+b.getAttribute('data-i')]; });
          loadGroups(picked, k, btn.getAttribute('data-d'));
        };
      });
      refresh();
    });
  }

  /** 讀取勾選的項目並開始轉換 */
  function loadGroups(groups, kind, device) {
    var files = [].concat.apply([], groups.map(function (gr) { return gr.files.map(function (f) { return { file: f.file, path: f.path }; }); }));
    readFiles(files).then(function (inputs) {
      closeModal();
      if (kind === 'l2csv') {
        if (state.kind === 'l2csv') { mergeInputs(inputs); run(); return; }
        if (device) { startL2csv(inputs, device); return; }
        askDevice(inputs);
        return;
      }
      if (state.kind !== kind) openKind(kind);
      mergeInputs(inputs);
      run();
    });
  }

  /** 同路徑的檔案取代，其餘加入 */
  function mergeInputs(files) {
    files.forEach(function (f) {
      var i = state.inputs.findIndex(function (x) { return inputKey(x) === inputKey(f); });
      if (i >= 0) state.inputs[i] = f; else state.inputs.push(f);
    });
  }

  // ─────────── 拖放／選檔 ───────────

  /** 拖放：支援直接拖資料夾進來（遞迴讀取） */
  function collectDropped(dt) {
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    var entries = items.map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
    var hasDir = entries.some(function (e) { return e.isDirectory; });
    if (!hasDir) return Promise.resolve({ files: Array.prototype.slice.call(dt.files), folder: null });
    var out = [];
    var walk = function (entry) {
      if (entry.isFile) {
        return new Promise(function (res) { entry.file(function (f) { out.push({ file: f, path: entry.fullPath.replace(/^\//, '') }); res(); }, function () { res(); }); });
      }
      if (entry.isDirectory) {
        var reader = entry.createReader();
        var all = [];
        var readBatch = function () {
          return new Promise(function (res) { reader.readEntries(res, function () { res([]); }); }).then(function (batch) {
            if (!batch.length) return Promise.all(all.map(walk));
            all = all.concat(batch);
            return readBatch();
          });
        };
        return readBatch();
      }
      return Promise.resolve();
    };
    var dirName = entries.filter(function (e) { return e.isDirectory; })[0].name;
    return Promise.all(entries.map(walk)).then(function () { return { files: out, folder: dirName }; });
  }

  var pickTarget = 'home';
  function bindDrop(zone, target) {
    zone.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button')) return;
      pickTarget = target; $('fileInput').value = ''; $('fileInput').click();
    });
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); zone.click(); } });
    ['dragenter', 'dragover'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) {
      collectDropped(e.dataTransfer).then(function (res) {
        if (res.folder) handleFolder(res.files, res.folder);
        else if (res.files.length) handleFiles(res.files);
      });
    });
  }
  bindDrop($('homeDrop'), 'home');
  bindDrop($('workDrop'), 'work');
  ['dragover', 'drop'].forEach(function (ev) { window.addEventListener(ev, function (e) { e.preventDefault(); }); });
  $('fileInput').addEventListener('change', function () { if (this.files.length) handleFiles(this.files); });

  var openDir = function () { $('dirInput').value = ''; $('dirInput').click(); };
  $('homeDirBtn').onclick = function (e) { e.stopPropagation(); openDir(); };
  $('workDirBtn').onclick = openDir;
  $('dirInput').addEventListener('change', function () {
    var fs = Array.prototype.slice.call(this.files);
    if (!fs.length) return;
    var first = fs[0].webkitRelativePath || fs[0].name;
    var folder = first.indexOf('/') >= 0 ? first.split('/')[0] : '資料夾';
    handleFolder(fs.map(function (f) { return { file: f, path: f.webkitRelativePath || f.name }; }), folder);
  });

  function handleFiles(list) {
    readFiles(list).then(function (files) {
      if (state.kind) { mergeInputs(files); run(); return; }
      // 首頁：自動判斷
      var kinds = {};
      var unknown = [];
      files.forEach(function (f) {
        var k = Core.detectKind(f.name, f.text);
        if (k) (kinds[k] = kinds[k] || []).push(f); else unknown.push(f.name);
      });
      var ks = Object.keys(kinds);
      if (!ks.length) {
        modal('<h3>認不出這個檔案</h3><p>' + esc(unknown.join('、')) + '</p><p>請直接在首頁點選要做的轉換，再放入檔案。</p><div style="text-align:right"><button class="btn primary" id="ok1">好</button></div>');
        $('ok1').onclick = closeModal;
        return;
      }
      var k = ks[0];
      if (ks.length > 1 || unknown.length) toast('一次只能做一種轉換，先處理「' + KINDS[k].title + '」的檔案');
      if (k === 'l2csv') { askDevice(kinds[k]); return; }
      openKind(k);
      mergeInputs(kinds[k]);
      run();
    });
  }

  // ─────────── 首頁卡片 ───────────
  Array.prototype.forEach.call(document.querySelectorAll('.card[data-kind]'), function (c) {
    c.onclick = function () { openKind(c.getAttribute('data-kind'), c.getAttribute('data-device')); };
  });
  $('btnBack').onclick = showHome;
})();
