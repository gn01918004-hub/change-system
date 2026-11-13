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
          '開啟土地重測系統，<b>讀入 .cnt 檔就好</b>（點號.編碼,Y,X），不用 MAC，也不用刪 99999、99998。',
          'Q 開頭的補點在 CNT 裡已改成參考點的形式（例如 QGGC32 → 42.11），對照方式看 <b>_編碼對照表.csv</b>。',
          '讀入後在重測系統裡抽查幾個點的坐標。'
        ];
      }
    },
    l2csv: {
      title: '重測資料 → 全站儀 / GPS 控制器',
      accept: '.l02,.l14,.l20,.txt',
      hint: '同一案件的 .L02、.L14、.L20 會合併成一個檔；也可以直接選整個資料夾',
      step2: '檢查結果',
      next: function (r) {
        if (r.format === 'sdr' || r.format === 'topcon') {
          return [
            '把存好的 <b>' + (r.format === 'sdr' ? '.sdr' : '.txt') + '</b> 檔傳到' + (r.format === 'sdr' ? ' SOKKIA' : ' TOPCON') + ' 全站儀（隨身碟 / SD 卡 / 傳輸軟體）。',
            '在儀器上用「匯入坐標」讀進來，格式和舊程式「複丈輸入檔2SOKKIA」轉出來的一樣。',
            '匯入後隨便抽查幾個點的坐標。'
          ];
        }
        return [
          '把存好的 <b>.' + r.ext + '</b> 檔複製到隨身碟 / SD 卡，或用傳輸線傳到全站儀或 GPS 控制器（兩種儀器用同一個檔）。',
          '在儀器上選「匯入坐標」，格式選 <b>點號, ' + (r.order === 'xy' ? 'X(E), Y(N)' : 'Y(N), X(E)') + '</b>（逗號分隔）。',
          '匯入後隨便抽查幾個點的坐標，確認沒有 X、Y 對調。'
        ];
      }
    },
    coa2csv: {
      title: '複丈輸入檔 → 全站儀 / GPS 控制器',
      accept: '.coa,.bnp,.par,.ctl,.d20',
      hint: '同名的 .COA（界址點）、.CTL（控制點）、.BNP、.PAR 一起放進來，最簡單是直接選整個資料夾',
      step2: '選擇範圍',
      next: function (r) { return KINDS.l2csv.next(r); }
    },
    basemap: {
      title: '輸出航照圖（JPG + JGW）',
      accept: '.l02,.l14,.l20,.d14',
      hint: '放入同一案件的 .L14（界址/參考點）、.L20（補點），最簡單是直接選整個資料夾；有 D14 時可以點 D14 的參考點當套合點',
      step2: '範圍與校正',
      next: function () { return []; }
    }
  };
  var GROUPED = { l2csv: 1, coa2csv: 1 };
  var BM_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m3 16 5-5 4 4 3-3 6 6"/><circle cx="15.5" cy="8.5" r="1.8"/></svg>'; // 依案件（同名檔）分組的轉換

  // ─────────── 狀態 ───────────
  var state = { fileRenames: {}, kind: null, inputs: [], opts: loadOpts(), result: null, decisions: {}, reviewFilter: null, lOff: {}, codes: {}, askAs: {}, coa: null, coaEnabled: false, dbf: null, dbfEdits: {}, dbfDone: null };

  function loadOpts() {
    var d = { ext: 'csv', macStyle: 'excel', neOrder: 'auto', badCodeTo: '11', codeMode: 'pad2', sep: 'space', alwaysZero: false, codeColumn: 'auto', angleDecimals: 0, distDecimals: 3, xyOrder: 'yx', coaCtlFirst: true, coaNearestN: 2, outFormat: 'csv', swapXY: false, stripCode: false };
    try {
      var s = JSON.parse(localStorage.getItem('chsys-opts') || '{}');
      for (var k in s) if (k in d) d[k] = s[k];
      if (!s.xyOrder && s.swapXY) d.xyOrder = 'xy'; // 舊版「交換坐標欄位」設定沿用
    } catch (e) {}
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
      return f.arrayBuffer().then(function (b) {
        var ext = Core.extName(f.name);
        var o = { name: f.name, path: path, text: ext === 'D14' || ext === 'D20' ? '' : decode(b) };
        if (ext === 'D14' || ext === 'D20') o.bytes = new Uint8Array(b);
        return o;
      });
    }));
  }
  function inputKey(f) { return f.path || f.name; }

  // ─────────── 畫面切換 ───────────
  function showHome() {
    $('toast').classList.add('hidden');
    state.kind = null; state.inputs = []; state.result = null; state.decisions = {};
    bmD14 = null;
    $('home').classList.remove('hidden'); $('work').classList.add('hidden');
    window.scrollTo(0, 0);
  }
  function openKind(kind) {
    state.kind = kind;
    state.inputs = []; state.result = null; state.opts.outName = ''; state.decisions = {}; state.reviewFilter = null; state.lOff = {}; state.codes = {}; state.askAs = {}; state.coa = null; state.dbf = null; state.dbfEdits = {}; state.dbfDone = null; state.showOldFiles = false; state.fileRenames = {}; state.bm = null;
    $('home').classList.add('hidden'); $('work').classList.remove('hidden');
    renderWork();
    window.scrollTo(0, 0);
  }
  function kindTitle() {
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
    if (GROUPED[state.kind] || state.kind === 'basemap') {
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
    if (state.dbf) ['D14', 'D20'].forEach(function (e) {
      var d = state.dbf[e];
      if (!d) return;
      addChip('🗄 ' + d.name + '（' + (e === 'D14' ? '參考點' : '補點') + ' ' + d.db.nrec + ' 筆）', '重測系統檔', function () { delete state.dbf[e]; if (!state.dbf.D14 && !state.dbf.D20) state.dbf = null; run(); });
    });
    $('pickBig').textContent = state.inputs.length ? '要換檔案或再加檔案？拖進來或點這裡' : '把檔案拖進來，或點這裡選擇';
    $('pickTitle').textContent = state.inputs.length ? '第 1 步：已放入 ' + state.inputs.length + ' 個檔案' : '第 1 步：放入檔案';
    renderTypeBar();
    if (!state.inputs.length) { $('resultArea').classList.add('hidden'); setSteps(1); }
  }

  var L_LABEL = { L02: '控制點', L14: '界址點/參考點', L20: '補點' };

  /** 重測資料：選擇要匯出哪幾種資料（預設全選） */
  function renderTypeBar() {
    var bar = $('typeBar');
    bar.innerHTML = '';
    if (state.kind !== 'l2csv') { bar.classList.add('hidden'); return; }
    var present = ['L02', 'L14', 'L20'].filter(function (e) {
      return state.inputs.some(function (f) { return Core.extName(f.name) === e; });
    });
    bar.classList.toggle('hidden', !present.length);
    if (!present.length) return;
    bar.appendChild(el('span', { 'class': 'lbl' }, '要匯出的資料：'));
    present.forEach(function (e) {
      var l = el('label', { 'class': 'tchk' + (state.lOff[e] ? '' : ' on') });
      var c = el('input', { type: 'checkbox' }); c.checked = !state.lOff[e];
      c.onchange = function () { state.lOff[e] = !c.checked; run(); };
      l.appendChild(c);
      l.appendChild(el('span', null, esc(L_LABEL[e]) + ' <span class="extb">' + e + '</span>'));
      bar.appendChild(l);
    });
  }

  // ─────────── 執行轉換 ───────────
  function run() {
    renderWork();
    if (!state.inputs.length) return;
    var o = state.opts, parts;
    if (state.kind === 'l2csv' || state.kind === 'basemap') {
      var groups = lGroups(state.inputs.filter(function (f) { return !state.lOff[Core.extName(f.name)]; }));
      if (!groups.length) {
        state.result = { kind: state.kind, ext: o.ext === 'txt' ? 'txt' : 'csv', files: [], parts: [], perFile: [], stats: { points: 0 },
          report: [{ level: 'error', msg: '沒有勾選任何要匯出的資料（控制點 / 界址點 / 補點），請在上方勾選至少一種' }] };
        renderResult();
        return;
      }
      parts = groups.map(function (g) {
        var base = (groups.length === 1 && o.outName) || g.label;
        var common = { order: o.xyOrder === 'xy' ? 'xy' : 'yx', stripCode: o.stripCode, ext: o.ext, format: o.outFormat };
        var x = Core.lToCsv(g.files, Object.assign({ outName: base }, common));
        x.source = g.label;
        return x;
      });
    } else if (state.kind === 'coa2csv') {
      var cg = lGroups(state.inputs);
      var c = coaState();
      parts = cg.map(function (g) {
        var x = Core.coaToCsv(g.files, {
          outName: (cg.length === 1 && o.outName) || undefined,
          parcels: cg.length === 1 && c.mode === 'pick' ? c.picked : null,
          ctl: c.ctl, nearestN: o.coaNearestN, ctlAdd: c.ctlAdd, ctlRemove: c.ctlRemove,
          format: o.outFormat,
          order: o.xyOrder === 'xy' ? 'xy' : 'yx', ext: o.ext
        });
        x.source = g.label;
        return x;
      });
    } else {
      parts = state.inputs.map(function (inp) {
        var key = inputKey(inp);
        var opt = { codeMode: o.codeMode, sep: o.sep, macStyle: o.macStyle, alwaysZero: o.alwaysZero, codeCol: o.codeColumn, neOrder: o.neOrder,
          angleDecimals: o.angleDecimals, distDecimals: o.distDecimals, decisions: state.decisions[key] || {}, codeOverrides: state.codes[key] || {}, noCodeAs: state.askAs[key], badCodeTo: o.badCodeTo,
          outName: state.inputs.length === 1 ? (o.outName || undefined) : undefined };
        if (state.dbf) opt.known = Core.knownFromDbf(state.dbf.D14 && state.dbf.D14.db, state.dbf.D20 && state.dbf.D20.db);
        var x = state.kind === 'raw2mac' ? Core.rawToMac(inp.text, inp.name, opt) : Core.csvToCntMac(inp.text, inp.name, opt);
        x.source = inp.name;
        x.key = key;
        x._inp = inp; x._opt = opt;
        return x;
      });
      // 有 D14／D20：依寫入規劃的改號（例如 1～14 → 26～39），讓 MAC／CNT 也用同樣的點號
      if (state.dbf && !state.dbfDone) {
        var plan0 = makeDbfPlan({ kind: state.kind, parts: parts });
        parts = parts.map(function (x) {
          var rn = { byLine: {}, byName: {} }, any = false;
          plan0.rows.forEach(function (row) {
            if (String(row.key).indexOf(x.key + ':') !== 0 || !row.out) return;
            if (row.target === 'D14' && row.out !== row.origName + '.' + String(row.origCode).padStart(2, '0')) { rn.byLine[row.line] = row.out; any = true; }
            if (row.target === 'D20' && state.kind === 'raw2mac' && row.out !== row.origName) { rn.byName[row.origName] = row.out; any = true; }
          });
          if (!any) return x;
          var opt2 = Object.assign({}, x._opt, { rename: rn });
          var y = state.kind === 'raw2mac' ? Core.rawToMac(x._inp.text, x._inp.name, opt2) : Core.csvToCntMac(x._inp.text, x._inp.name, opt2);
          y.source = x.source; y.key = x.key; y._inp = x._inp; y._opt = opt2; y.renamedCount = Object.keys(rn.byLine).length + Object.keys(rn.byName).length;
          return y;
        });
      }
    }
    var r = { kind: state.kind, format: GROUPED[state.kind] ? (o.outFormat || 'csv') : null, order: o.xyOrder === 'xy' ? 'xy' : 'yx', ext: o.ext === 'txt' ? 'txt' : 'csv', files: [], report: [], parts: parts, stats: {} };
    parts.forEach(function (p) {
      r.files = r.files.concat(p.files);
      p.report.forEach(function (it) {
        r.report.push({ level: it.level, msg: (parts.length > 1 ? '【' + p.source + '】' : '') + it.msg, line: it.line });
      });
      for (var k in p.stats) if (typeof p.stats[k] === 'number') r.stats[k] = (r.stats[k] || 0) + p.stats[k];
    });
    if (state.kind === 'csv2cntmac') r.stats.maxErrMm = Math.max.apply(null, parts.map(function (p) { return p.stats.maxErrMm || 0; }));
    // 使用者改過的檔名
    r.files.forEach(function (f) { f.origName = f.name; if (state.fileRenames[f.name]) f.name = state.fileRenames[f.name]; });
    if (GROUPED[state.kind] || state.kind === 'basemap') r.perFile = [].concat.apply([], parts.map(function (p) { return p.perFile; }));
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
    var nPending = r.kind === 'csv2cntmac' ? (r.stats.pending || 0) : 0;
    if (nPending && r.files.length) {
      st.className = 'status warn';
      st.innerHTML = '<div class="si">?</div><div><div class="st">還差一步：有 ' + nPending + ' 點要決定編碼</div><div class="ss">沒有編碼但有高程，可能是現場收的點。請在下面「點位檢查」回答要編成幾號（00～99），回答後就能下載。</div></div>';
      setSteps(2);
    } else if (!r.files.length) {
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

    if (r.kind === 'basemap') { renderBasemapOnly(r); return; }
    ['previewPanel', 'optsPanel'].forEach(function (id) { $(id).classList.remove('hidden'); });
    renderThumbs(r);
    renderReview(r);
    renderCoaPanel(r);
    renderDbfPanel(r);
    renderBasemapPanel(r);

    // 副檔名選擇（重測資料匯出時顯示在存檔區最上面）
    var db = $('deviceBar'); db.innerHTML = '';
    db.classList.toggle('hidden', !GROUPED[r.kind]);
    if (GROUPED[r.kind]) {
      var fmt = state.opts.outFormat || 'csv';
      var row0 = el('div', { 'class': 'devrow' });
      row0.appendChild(el('span', { 'class': 'lbl' }, '輸出格式：'));
      var fseg = el('div', { 'class': 'seg' });
      [['csv', '通用 CSV（點號,Y,X）'], ['sdr', 'SOKKIA .sdr'], ['topcon', 'TOPCON .txt']].forEach(function (c) {
        var b = el('button', { type: 'button', 'class': fmt === c[0] ? 'on' : '' }, c[1]);
        b.onclick = function () { state.opts.outFormat = c[0]; saveOpts(); run(); };
        fseg.appendChild(b);
      });
      row0.appendChild(fseg);
      if (fmt !== 'csv') row0.appendChild(el('span', { 'class': 'muted' }, '格式和舊程式「複丈輸入檔2SOKKIA」完全相同（Y、X 順序固定）'));
      db.appendChild(row0);
      if (fmt !== 'csv') {
        // SOKKIA / TOPCON 格式固定，不用選副檔名與坐標順序
      } else {
      db.appendChild(el('span', { 'class': 'lbl' }, '副檔名：'));
      var eseg = el('div', { 'class': 'seg' });
      [['csv', '.csv'], ['txt', '.txt']].forEach(function (c) {
        var b = el('button', { type: 'button', 'class': (state.opts.ext || 'csv') === c[0] ? 'on' : '', title: c[0] === 'csv' ? '預設' : '儀器只認 .txt 時使用' }, c[1]);
        b.onclick = function () { state.opts.ext = c[0]; saveOpts(); run(); };
        eseg.appendChild(b);
      });
      db.appendChild(eseg);
      db.appendChild(el('span', { 'class': 'muted' }, '內容相同，只差副檔名'));
      // 坐標順序（預設 Y,X）；附上第一點當例子，一眼看出 27… / 21… 在哪
      var row2 = el('div', { 'class': 'devrow' });
      row2.appendChild(el('span', { 'class': 'lbl' }, '坐標順序：'));
      var oseg = el('div', { 'class': 'seg' });
      [['yx', 'Y , X（預設）'], ['xy', 'X , Y']].forEach(function (c) {
        var b = el('button', { type: 'button', 'class': (state.opts.xyOrder || 'yx') === c[0] ? 'on' : '' }, c[1]);
        b.onclick = function () { state.opts.xyOrder = c[0]; saveOpts(); run(); };
        oseg.appendChild(b);
      });
      row2.appendChild(oseg);
      var first = r.parts.length && r.parts[0].preview[0];
      if (first) {
        var ex = r.order === 'xy' ? [first.name, first.x, first.y] : [first.name, first.y, first.x];
        row2.appendChild(el('span', { 'class': 'muted' }, '例：<span class="mono">' + esc(ex.join(',')) + '</span>（Y 是 7 位整數、X 是 6 位整數，系統會自動判斷原檔哪個是 Y）'));
      }
      db.appendChild(row2);
      }
    }

    // 有放 D14／D20：直接寫入是主力（第 3 步），舊的 CNT＋MAC 收起來
    var dbfMode = !!(state.dbf && DBF_KINDS[r.kind]);
    $('step3Label').textContent = dbfMode ? '寫入重測系統' : '存檔';
    var fp = $('filesPanel');
    fp.classList.toggle('folded', dbfMode && !state.showOldFiles);
    if (dbfMode) {
      $('filesTitle').innerHTML = '不直接寫入時用：' + (r.kind === 'csv2cntmac' ? 'CNT 檔（補點改成參考點的形式）' : 'MAC 檔') +
        ' <span class="muted">平常不用</span><button class="btn small foldbtn" type="button" id="foldOld">' + (state.showOldFiles ? '收起來' : '展開') + '</button>';
      $('foldOld').onclick = function () { state.showOldFiles = !state.showOldFiles; renderResult(); };
    } else {
      $('filesTitle').textContent = '第 3 步：存檔 — 按綠色按鈕下載';
    }

    // 檔案（GPS 還有點沒決定編碼時先不給下載，避免存到暫用的 .00）
    var fw = $('files'); fw.innerHTML = '';
    if (nPending && r.files.length) {
      $('filesPanel').classList.remove('hidden');
      $('saveAll').innerHTML = '';
      fw.innerHTML = '<div class="blocked">🔒 還有 <b>' + nPending + '</b> 點沒有決定編碼，回答上面「點位檢查」的問題後，這裡就會出現下載按鈕。' +
        ' <button class="btn small" type="button" id="goAsk">回到問題</button></div>';
      $('goAsk').onclick = function () { var a = document.querySelector('.askbox'); if (a) a.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    } else {
      $('filesPanel').classList.toggle('hidden', !r.files.length);
      var mainFiles = r.files.filter(function (f) { return !f.old; });
      var oldFiles = r.files.filter(function (f) { return f.old; });
      var shown = mainFiles.concat(state.showOldMac ? oldFiles : []);
      shown.forEach(function (f) {
        var d = el('div', { 'class': 'file' + (f.recommended ? ' rec' : '') });
        var lines = f.content.split('\r\n').length - 1;
        d.innerHTML = '<div class="grow"><div class="fn"><span class="fname" tabindex="0" role="button" title="點一下改檔名">' + esc(f.name) + ' <span class="pen">✏️</span></span>' +
          (f.name !== f.origName ? ' <span class="muted renamed">（原檔名 ' + esc(f.origName) + '）</span>' : '') +
          (f.recommended ? '<span class="badge rec">建議使用</span>' : '') + '</div>' +
          '<div class="fd">' + esc(f.desc || '') + '（' + lines + ' 行）</div></div>';
        bindRename(d.querySelector('.fname'), f);
        var stat = el('div', { 'class': 'fstat ' + (saveLog[f.origName || f.name] ? saveLog[f.origName || f.name].kind : ''), 'data-key': f.origName || f.name });
        stat.textContent = saveLog[f.origName || f.name] ? saveLog[f.origName || f.name].text : '';
        d.querySelector('.grow').appendChild(stat);
        var view = el('button', { 'class': 'btn small' }, '看內容');
        var dl = el('button', { 'class': 'btn go' }, '⬇ 下載');
        var pre = el('pre', { 'class': 'view hidden' });
        pre.textContent = f.content.length > 200000 ? f.content.slice(0, 200000) + '\n…（太長，只顯示前段）' : f.content;
        view.onclick = function () { pre.classList.toggle('hidden'); view.textContent = pre.classList.contains('hidden') ? '看內容' : '收起來'; };
        dl.onclick = function () { download(f); };
        if (f.old) d.className += ' oldfile';
        d.appendChild(view); d.appendChild(dl); d.appendChild(pre);
        fw.appendChild(d);
      });
      if (oldFiles.length) {
        var ob = el('div', { 'class': 'oldrow' }, '<span class="muted">舊方式（虛擬測站 99999／99998 的 CNT＋MAC，現在不用了）</span> ');
        var obtn = el('button', { 'class': 'btn small', type: 'button' }, state.showOldMac ? '收起來' : '展開');
        obtn.onclick = function () { state.showOldMac = !state.showOldMac; renderResult(); };
        ob.appendChild(obtn);
        fw.appendChild(ob);
      }
      var sa = $('saveAll'); sa.innerHTML = '';
      if (mainFiles.length > 1) {
        var all = el('button', { 'class': 'btn primary' }, '全部下載（' + mainFiles.length + ' 個）');
        all.onclick = function () { downloadAll(mainFiles); };
        sa.appendChild(all);
      }
      if (mainFiles.length) sa.appendChild(makeSaveDirBtn());
    }

    // 下一步
    var nx = $('next'); nx.innerHTML = '';
    $('nextPanel').classList.toggle('hidden', !r.files.length);
    var steps = dbfMode && !state.dbfDone ? [
      '寫入前先<b>關掉重測系統</b>（至少關掉這個案件），避免和系統同時改到 D14、D20。',
      '在上面「第 3 步」確認點號、編碼（黃色是自動改號），再按綠色的 <b>💾 直接寫入原檔</b>，選重測系統放 D14、D20 的資料夾。系統會先把原檔備份成 .bak。',
      '打開重測系統檢查新加的參考點、補點；有問題可以用 .bak 還原。'
    ] : dbfMode ? [
      '打開重測系統檢查新加的參考點、補點；有問題可以用 .bak 還原。',
      '要再寫入其他資料，請重新放入最新的 D14、D20。'
    ] : KINDS[r.kind].next(r);
    steps.forEach(function (t) { nx.appendChild(el('li', null, '<div>' + t + '</div>')); });

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

  /** 輸出航照圖：只顯示航照面板 */
  function renderBasemapOnly(r) {
    ['thumbPanel', 'coaPanel', 'reviewPanel', 'dbfPanel', 'filesPanel', 'nextPanel', 'previewPanel', 'optsPanel'].forEach(function (id) { $(id).classList.add('hidden'); });
    var area = bmArea(r), st = $('status');
    if (area) {
      st.className = 'status ok';
      st.innerHTML = '<div class="si">🛰</div><div><div class="st">讀到 ' + bmAllPoints(r).length + ' 個點，可以抓航照了</div><div class="ss">' + esc(bmDatumText()) + '範圍以 ' + area.main.length + ' 個點為中心，約 ' + Math.round(area.size[0]) + ' × ' + Math.round(area.size[1]) + ' m。照下面 1～4 步做。</div></div>';
    }
    setSteps(bmState().out ? 3 : 2);
    renderBasemapPanel(r);
    var rp = $('report'); rp.innerHTML = '';
    var items = r.report.filter(function (x) { return x.level === 'error'; });
    $('reportPanel').classList.toggle('hidden', !items.length);
    items.forEach(function (it) { rp.appendChild(el('li', { 'class': it.level }, '<span class="lv">錯誤</span><span>' + esc(it.msg) + '</span>')); });
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
    l2csv: [['ctl', '控制點 L02'], ['bnd', '界址點/參考點 L14'], ['add', '補點 L20']],
    basemap: [['ctl', '控制點 L02'], ['bnd', '界址點/參考點 L14'], ['add', '補點 L20']],
    coa2csv: [['ctl', '控制點 .CTL'], ['bnd', '界址點 .COA']]
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
    var map = { '控制點': 'ctl', '界址點/參考點': 'bnd', '界址點': 'bnd', '補點': 'add' };
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

  // ═════════════ 複丈輸入檔：選擇範圍 ═════════════

  function coaState() {
    if (!state.coa) state.coa = { mode: 'all', picked: [], ctl: 'all', search: '', ctlAdd: [], ctlRemove: [], ctlSearch: '' };
    return state.coa;
  }

  /** 「12」「12-3」「10~15」「1,2,5」都可以 */
  function parseParcelInput(text, known) {
    var out = [];
    String(text).split(/[\s,，、;；]+/).forEach(function (tok) {
      if (!tok) return;
      var m = /^0*(\d+)\s*[~～]\s*0*(\d+)$/.exec(tok);
      if (m) {
        var a = +m[1], b = +m[2];
        if (b < a) { var t = a; a = b; b = t; }
        for (var i = a; i <= b && i - a < 5000; i++) if (!known || known[String(i)]) out.push(String(i));
        return;
      }
      var k = Core.parcelKeyOf(tok);
      if (k) out.push(k);
    });
    return out;
  }

  var PARCEL_SHOW = 300;

  /** 控制點名稱：「BKC001 BKC005」「BKC161~BKC170」「BKC161~170」都可以（不分大小寫） */
  function parseCtlInput(text, names) {
    var byUp = {};
    names.forEach(function (n) { byUp[n.toUpperCase()] = n; });
    var out = [];
    String(text).split(/[\s,，、;；]+/).forEach(function (tok) {
      if (!tok) return;
      var m = /^([A-Za-z]*)(\d+)\s*[~～]\s*([A-Za-z]*)(\d+)$/.exec(tok);
      if (m) {
        var pre = m[1].toUpperCase(), a = parseInt(m[2], 10), b = parseInt(m[4], 10), w = m[2].length;
        if (b < a) { var t = a; a = b; b = t; }
        for (var i = a; i <= b && i - a < 2000; i++) {
          var nm = pre + String(i).padStart(w, '0');
          if (byUp[nm]) out.push(byUp[nm]);
        }
        return;
      }
      if (byUp[tok.toUpperCase()]) out.push(byUp[tok.toUpperCase()]);
    });
    return out;
  }
  function renderCoaPanel(r) {
    var panel = $('coaPanel');
    if (r.kind !== 'coa2csv' || !r.parts.length) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    var c = coaState();
    var o = state.opts;
    var single = r.parts.length === 1;
    var p = r.parts[0];
    var parcels = single ? p.parcels : [];
    var canPick = single && parcels.length > 0;
    if (!canPick && c.mode === 'pick') c.mode = 'all';
    var known = {};
    parcels.forEach(function (x) { known[x.key] = x; });

    var h = '<div class="coarow"><span class="lbl">界址點：</span><div class="seg" id="coaMode">' +
      '<button type="button" data-v="all" class="' + (c.mode === 'all' ? 'on' : '') + '">全部' + (single && p.stats.totalBnd ? '（' + p.stats.totalBnd + ' 點）' : '') + '</button>' +
      '<button type="button" data-v="pick" class="' + (c.mode === 'pick' ? 'on' : '') + '"' + (canPick ? '' : ' disabled title="需要 .BNP 檔，且一次只放一個案件"') + '>指定地號</button></div>' +
      (canPick ? '' : '<span class="muted">' + (single ? '沒有 .BNP 檔，無法依地號挑選' : '一次放多個案件時只能全部匯出') + '</span>') + '</div>';

    if (c.mode === 'pick') {
      h += '<div class="pickbox">' +
        '<div class="coarow"><input type="text" id="pqInput" placeholder="直接輸入地號，例如：12 15-1 20~25" style="flex:1;min-width:220px">' +
        '<button class="btn small primary" type="button" id="pqAdd">加入</button>' +
        '<button class="btn small" type="button" id="pqClear"' + (c.picked.length ? '' : ' disabled') + '>全部清除</button></div>' +
        '<div class="picked">' + (c.picked.length ? '已選 <b>' + c.picked.length + '</b> 筆地號：' + c.picked.map(function (k) {
          return '<span class="chip">' + esc(k) + (known[k] ? '' : ' <span style="color:var(--err)">（找不到）</span>') + ' <button type="button" data-rm="' + esc(k) + '" aria-label="移除 ' + esc(k) + '">×</button></span>';
        }).join('') : '<span class="muted">還沒有選地號，請在上面輸入或在下面清單勾選。</span>') + '</div>' +
        '<div class="coarow"><input type="search" id="pqSearch" placeholder="搜尋地號" value="' + esc(c.search) + '" style="width:180px"><span class="muted" id="pqCount"></span></div>' +
        '<div class="plist" id="pqList"></div></div>';
    }

    var ctlList = single ? (p.ctlList || []) : [];
    h += '<div class="coarow"><span class="lbl">控制點：</span><div class="seg" id="coaCtl">' +
      [['all', '全部'], ['nearest', '每筆地號最近的點'], ['none', '不要']].map(function (b) {
        return '<button type="button" data-v="' + b[0] + '" class="' + (c.ctl === b[0] ? 'on' : '') + '">' + b[1] + '</button>';
      }).join('') + '</div>' +
      (c.ctl === 'nearest' ? '每筆取 <input type="text" id="coaN" inputmode="numeric" value="' + esc(o.coaNearestN) + '" style="width:52px;text-align:center"> 點（一組兩點：測站＋後視）' : '') +
      '<span class="muted">' + (single ? '選了 ' + p.stats.ctl + ' / ' + (p.stats.totalCtl || 0) + ' 點' : '') + '</span></div>';
    if (single && ctlList.length) {
      var sel = ctlList.filter(function (x) { return x.selected; });
      h += '<div class="pickbox"><div class="coarow"><b>手動加減控制點</b>' +
        '<input type="text" id="cqInput" placeholder="例如：BKC001 BKC161~BKC170" style="flex:1;min-width:200px">' +
        '<button class="btn small primary" type="button" id="cqAdd">加入</button>' +
        '<button class="btn small" type="button" id="cqReset"' + (c.ctlAdd.length || c.ctlRemove.length ? '' : ' disabled') + '>取消手動調整</button></div>' +
        '<div class="picked">' + (sel.length ? '會輸出 <b>' + sel.length + '</b> 點：' + sel.map(function (x) {
          return '<span class="chip" title="' + esc(x.auto || '手動加入') + '">' + esc(x.name) + (x.added && !x.auto ? ' <span class="muted">手動</span>' : '') +
            ' <button type="button" data-crm="' + esc(x.name) + '" aria-label="移除 ' + esc(x.name) + '">×</button></span>';
        }).join('') : '<span class="muted">目前沒有控制點。</span>') + '</div>' +
        '<div class="coarow"><input type="search" id="cqSearch" placeholder="搜尋控制點" value="' + esc(c.ctlSearch) + '" style="width:180px"><span class="muted">勾選＝輸出，滑鼠移到點名上可看為什麼被選</span></div>' +
        '<div class="plist" id="cqList"></div></div>';
    }

    h += '<div class="coarow"><span class="lbl">排序：</span><span class="muted">一律界址點在前、控制點在後</span></div>';
    $('coa').innerHTML = h;

    var segBind = function (id, fn) {
      Array.prototype.forEach.call($(id).querySelectorAll('button'), function (b) { b.onclick = function () { fn(b.getAttribute('data-v')); }; });
    };
    segBind('coaMode', function (v) {
      if (v === c.mode) return;
      c.mode = v;
      if (v === 'pick' && c.ctl === 'all') c.ctl = 'nearest'; // 挑地號時，控制點預設取每筆地號最近的
      if (v === 'all' && c.ctl === 'nearest') c.ctl = 'all';
      run();
    });
    segBind('coaCtl', function (v) { c.ctl = v; run(); });
    if ($('coaN')) $('coaN').onchange = function () {
      var v = parseInt(this.value, 10);
      if (!(v >= 1 && v <= 20)) { toast('請輸入 1～20'); this.value = o.coaNearestN; return; }
      o.coaNearestN = v; saveOpts(); run();
    };
    // 手動加減控制點
    if ($('cqList')) {
      var setSel = function (name, on) {
        var item = ctlList.filter(function (x) { return x.name === name; })[0];
        var isAuto = item && item.auto;
        c.ctlAdd = c.ctlAdd.filter(function (n) { return n !== name; });
        c.ctlRemove = c.ctlRemove.filter(function (n) { return n !== name; });
        if (on && !isAuto) c.ctlAdd.push(name);
        if (!on && isAuto) c.ctlRemove.push(name);
      };
      $('cqAdd').onclick = function () {
        var names = parseCtlInput($('cqInput').value, ctlList.map(function (x) { return x.name; }));
        if (!names.length) { toast('找不到這些控制點，例如：BKC001 BKC161~BKC170'); return; }
        names.forEach(function (n) { setSel(n, true); });
        run();
      };
      $('cqInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('cqAdd').click(); });
      $('cqReset').onclick = function () { c.ctlAdd = []; c.ctlRemove = []; run(); };
      Array.prototype.forEach.call(panel.querySelectorAll('[data-crm]'), function (b) {
        b.onclick = function () { setSel(b.getAttribute('data-crm'), false); run(); };
      });
      var drawCtl = function () {
        var q = c.ctlSearch.trim().toUpperCase();
        var list = ctlList.filter(function (x) { return !q || x.name.toUpperCase().indexOf(q) >= 0; });
        $('cqList').innerHTML = list.slice(0, PARCEL_SHOW).map(function (x) {
          return '<label class="pitem' + (x.selected ? ' on' : '') + '" title="' + esc(x.auto || (x.added ? '手動加入' : '')) + '"><input type="checkbox" data-c="' + esc(x.name) + '"' + (x.selected ? ' checked' : '') + '>' +
            '<b>' + esc(x.name) + '</b><span class="muted">' + (x.auto && x.selected ? '自動' : x.added ? '手動' : x.removed ? '已移除' : '') + '</span></label>';
        }).join('');
        Array.prototype.forEach.call($('cqList').querySelectorAll('input[data-c]'), function (cb) {
          cb.onchange = function () { setSel(cb.getAttribute('data-c'), cb.checked); run(); };
        });
      };
      $('cqSearch').addEventListener('input', function () { c.ctlSearch = this.value; drawCtl(); });
      drawCtl();
    }
    if (c.mode !== 'pick') return;

    var add = function (keys) {
      keys.forEach(function (k) { if (c.picked.indexOf(k) < 0) c.picked.push(k); });
      run();
    };
    $('pqAdd').onclick = function () {
      var keys = parseParcelInput($('pqInput').value, known);
      if (!keys.length) { toast('看不懂這些地號，例如：12 15-1 20~25'); return; }
      add(keys);
    };
    $('pqInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('pqAdd').click(); });
    $('pqClear').onclick = function () { c.picked = []; run(); };
    Array.prototype.forEach.call(panel.querySelectorAll('[data-rm]'), function (b) {
      b.onclick = function () { c.picked = c.picked.filter(function (k) { return k !== b.getAttribute('data-rm'); }); run(); };
    });
    var drawList = function () {
      var q = c.search.trim();
      var list = parcels.filter(function (x) { return !q || x.key.indexOf(q) === 0 || x.key === Core.parcelKeyOf(q); });
      $('pqCount').textContent = (q ? '符合 ' : '共 ') + list.length + ' 筆' + (list.length > PARCEL_SHOW ? '，只列出前 ' + PARCEL_SHOW + ' 筆，請用搜尋' : '');
      $('pqList').innerHTML = list.slice(0, PARCEL_SHOW).map(function (x) {
        var on = c.picked.indexOf(x.key) >= 0;
        return '<label class="pitem' + (on ? ' on' : '') + '"><input type="checkbox" data-k="' + esc(x.key) + '"' + (on ? ' checked' : '') + (x.points ? '' : ' disabled') + '>' +
          '<b>' + esc(x.key) + '</b><span class="muted">' + (x.points ? x.points + ' 點' : '有簿無圖') + (x.area ? '・' + esc(x.area) + ' ㎡' : '') + '</span></label>';
      }).join('');
      Array.prototype.forEach.call($('pqList').querySelectorAll('input[data-k]'), function (cb) {
        cb.onchange = function () {
          var k = cb.getAttribute('data-k');
          if (cb.checked) { if (c.picked.indexOf(k) < 0) c.picked.push(k); } else c.picked = c.picked.filter(function (x) { return x !== k; });
          run();
        };
      });
    };
    $('pqSearch').addEventListener('input', function () { c.search = this.value; drawList(); });
    drawList();
  }

  // ═════════════ 直接寫入重測系統檔（D14／D20） ═════════════

  function attachDbf(f) {
    var ext = Core.extName(f.name);
    try {
      var db = Core.parseDbf(f.bytes);
      var need = ext === 'D14' ? 'COT_NUMBER' : 'CTL_NAME';
      if (!db.fields.some(function (x) { return x.name === need; })) throw new Error('欄位不對，不是重測系統的 ' + ext);
      state.dbf = state.dbf || {};
      state.dbf[ext] = { name: f.name, path: f.path, bytes: f.bytes, db: db };
      state.dbfDone = null;
    } catch (e) {
      toast('讀不懂 ' + f.name + '：' + e.message);
    }
  }

  /** 從轉換結果整理出要寫入的點 */
  function dbfPoints(r) {
    var pts = [];
    var badTo = state.opts.badCodeTo || '11';
    if (r.kind === 'csv2cntmac') {
      r.parts.forEach(function (p) {
        p.points.forEach(function (q) {
          if (!q.include) return;
          pts.push({ key: p.key + ':' + q.line, name: q.name, code: q.useCode == null || q.useCode === '' ? null : q.useCode,
            y: q.N, x: q.E, src: 'GPS', line: q.line, file: p.source });
        });
      });
    } else if (r.kind === 'raw2mac') {
      r.parts.forEach(function (p) {
        var seen = {};
        ((p.plot && p.plot.obs) || []).forEach(function (o) {
          if (o.wasKnown && o.knownFrom !== 'dbf') return; // 照準 RAW 裡 UP 已知點（檢核）不寫入；D14／D20 裡的點交給 6 cm 規則判斷
          var code = /^\d{1,2}$/.test(String(o.code).trim()) ? String(o.code).trim() : (String(o.code).trim() ? badTo : null);
          var k = o.pt + '|' + code;
          if (seen[k]) return; // 同一點重複觀測，取第一次
          seen[k] = 1;
          pts.push({ key: p.key + ':' + o.line, name: o.pt, code: /^q/i.test(o.pt) ? '' : code, y: o.N, x: o.E, src: '全站儀', line: o.line, file: p.source });
        });
      });
    }
    return pts;
  }

  function makeDbfPlan(r) {
    var D14 = state.dbf && state.dbf.D14, D20 = state.dbf && state.dbf.D20;
    return Core.planDbfWrite({ d14: D14 && D14.db, d20: D20 && D20.db, points: dbfPoints(r), edits: state.dbfEdits, badCodeTo: state.opts.badCodeTo || '11' });
  }

  var DBF_SHOW = 500;
  function renderDbfPanel(r) {
    var panel = $('dbfPanel');
    if (!state.dbf || !DBF_KINDS[r.kind]) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    var D14 = state.dbf.D14, D20 = state.dbf.D20;
    if (state.dbfDone) {
      $('dbf').innerHTML = '<div class="status ok" style="margin:0"><div class="si">✓</div><div><div class="st">已寫入重測系統檔</div><div class="ss">' + state.dbfDone + '</div></div></div>' +
        '<p class="muted">要再寫一次，請重新放入最新的 D14、D20（避免重複寫入）。</p>';
      return;
    }
    var plan = makeDbfPlan(r);
    state.dbfPlan = plan;
    var S = { new: ['新增', 'ok'], renumbered: ['自動改號', 'w'], edited: ['手動指定', 'ok'], needCode: ['缺編碼', 'x'], conflict: ['衝突', 'x'], skip: ['無法寫入', 'x'], excluded: ['不寫入', ''], noFile: ['缺檔案', 'x'],
      near: ['重測・未寫入', 'w'], remeasure: ['重測→新參考點', 'w'] };
    var h = '<p class="sum">' +
      (D14 ? '<b>' + esc(D14.name) + '</b>（參考點，原有 ' + D14.db.nrec + ' 筆）將新增 <b>' + plan.toD14.length + '</b> 筆' : '沒有放入 D14（參考點不會寫入）') + '；' +
      (D20 ? '<b>' + esc(D20.name) + '</b>（補點，原有 ' + D20.db.nrec + ' 筆）將新增 <b>' + plan.toD20.length + '</b> 筆' : '沒有放入 D20（Q 開頭的補點不會寫入）') + '。' +
      (plan.renumbered ? '其中 <b>' + plan.renumbered + '</b> 點點號重複，已自動改號（見下表黃色）。' : '') +
      (plan.near ? '另有 <b>' + plan.near + '</b> 點和已有的點相差 6 cm 內，視為重測、預設不寫入（要寫入就打勾，會寫成新的參考點）。' : '') +
      (r.parts.some(function (p) { return p.renamedCount; }) ? '改號後的點號也已套用到下面的 ' + (r.kind === 'raw2mac' ? 'MAC' : 'CNT') + ' 檔。' : '') + '</p>' +
      '<p class="muted" style="margin:-4px 0 10px">規則：點名 Q 開頭 → D20 補點；數字點號 → D14 參考點（點號＋編碼，COT_SOURCE 寫 2＝計算求得）。點號可以在表格裡直接改。</p>';
    if (plan.blocking.length) h += '<div class="blocked" style="margin-bottom:10px">⚠ 有 <b>' + plan.blocking.length + '</b> 點要先處理（缺編碼或點號衝突），處理完才能寫入。</div>';
    var rows = plan.rows.slice().sort(function (a, b) {
      var RK = { needCode: 0, conflict: 0, near: 1, remeasure: 1, renumbered: 2, skip: 3, noFile: 3 };
      var rk = function (x) { return RK[x.status] != null ? RK[x.status] : 4; };
      return rk(a) - rk(b);
    });
    h += '<div class="tablewrap"><table><thead><tr><th class="c">寫入</th><th class="l">原點名</th><th>原編碼</th><th class="l">寫到</th><th class="l">寫入點號</th><th>Y</th><th>X</th><th class="l">來源</th><th class="l">狀態</th></tr></thead><tbody>';
    rows.slice(0, DBF_SHOW).forEach(function (row) {
      var st = S[row.status] || [row.status, ''];
      var editable = row.target && row.status !== 'skip' && row.status !== 'noFile' && row.status !== 'excluded' && row.status !== 'near';
      var numCell = '';
      if (editable && row.target === 'D14') {
        numCell = '<input class="dnum" data-k="' + esc(row.key) + '" value="' + esc(row.num == null ? '' : row.num) + '" inputmode="numeric" maxlength="5" title="點號">' +
          ' . <input class="dref" data-k="' + esc(row.key) + '" value="' + esc(row.ref == null ? '' : String(row.ref).padStart(2, '0')) + '" inputmode="numeric" maxlength="2" placeholder="??" title="編碼 00～99">';
      } else if (editable && row.target === 'D20') {
        numCell = '<input class="dname" data-k="' + esc(row.key) + '" value="' + esc(row.name || '') + '" maxlength="8" title="補點名稱（最多 8 字）">';
      } else numCell = esc(row.out || '');
      var isNear = row.status === 'near' || row.status === 'remeasure';
      var chk = row.target ? (isNear
        ? '<input type="checkbox" class="dwrite" data-k="' + esc(row.key) + '"' + (row.status === 'remeasure' ? ' checked' : '') + ' title="6 cm 內的重測點：打勾＝寫成新的參考點">'
        : '<input type="checkbox" class="dchk" data-k="' + esc(row.key) + '"' + (row.status === 'excluded' ? '' : ' checked') + '>') : '';
      h += '<tr class="' + (row.status === 'excluded' || row.status === 'near' ? 'off' : '') + '"><td class="c">' + chk + '</td>' +
        '<td class="l mono">' + esc(row.origName) + '</td><td class="mono">' + esc(row.origCode) + '</td><td class="l">' + (row.target ? '.' + row.target + (row.target === 'D14' ? ' 參考點' : ' 補點') : '—') + '</td>' +
        '<td class="l mono">' + numCell + '</td><td class="mono">' + Number(row.y).toFixed(3) + '</td><td class="mono">' + Number(row.x).toFixed(3) + '</td>' +
        '<td class="l">' + esc(row.src) + '</td><td class="l"><span class="flagb ' + st[1] + '">' + st[0] + '</span> ' + esc(row.reason || '') + '</td></tr>';
    });
    h += '</tbody></table></div>';
    if (rows.length > DBF_SHOW) h += '<div class="muted" style="padding:8px">只列出前 ' + DBF_SHOW + ' 點，共 ' + rows.length + ' 點。</div>';
    var canWrite = !plan.blocking.length && (plan.toD14.length || plan.toD20.length);
    h += '<div class="saveall">' +
      (window.showDirectoryPicker ? '<button class="btn go" type="button" id="dbfWrite"' + (canWrite ? '' : ' disabled') + '>💾 直接寫入原檔（先自動備份 .bak）</button>' : '') +
      '<button class="btn primary" type="button" id="dbfDl"' + (canWrite ? '' : ' disabled') + '>⬇ 下載新的 D14 / D20</button>' +
      '<button class="btn" type="button" id="dbfTable">⬇ 下載對照表</button><span id="dbfSaveDir"></span>' +
      (window.showDirectoryPicker ? '' : '<span class="muted">這個瀏覽器不能直接寫回原檔，請用 Chrome 或 Edge，或下載後自己取代。</span>') + '</div>';
    $('dbf').innerHTML = h;

    var edit = function (k) { return (state.dbfEdits[k] = state.dbfEdits[k] || {}); };
    Array.prototype.forEach.call($('dbf').querySelectorAll('.dchk'), function (c) {
      c.onchange = function () { edit(c.getAttribute('data-k')).skip = !c.checked; run(); };
    });
    Array.prototype.forEach.call($('dbf').querySelectorAll('.dwrite'), function (c) {
      c.onchange = function () { edit(c.getAttribute('data-k')).write = c.checked; run(); };
    });
    Array.prototype.forEach.call($('dbf').querySelectorAll('.dnum'), function (c) {
      c.onchange = function () { var v = c.value.trim(); if (v && !/^\d{1,5}$/.test(v)) { toast('點號要是數字'); return; } edit(c.getAttribute('data-k')).num = v; run(); };
    });
    Array.prototype.forEach.call($('dbf').querySelectorAll('.dref'), function (c) {
      c.onchange = function () { var v = c.value.trim(); if (v && !/^\d{1,2}$/.test(v)) { toast('編碼要是 00～99'); return; } edit(c.getAttribute('data-k')).ref = v; run(); };
    });
    Array.prototype.forEach.call($('dbf').querySelectorAll('.dname'), function (c) {
      c.onchange = function () { edit(c.getAttribute('data-k')).name = c.value.trim(); run(); };
    });
    var build = function () { return Core.buildDbfFiles(plan, D14 && D14.db, D20 && D20.db); };
    $('dbfTable').onclick = function () {
      var b = build();
      download({ name: Core.baseName((D14 || D20).name) + '_寫入對照表.csv', content: b.table });
    };
    $('dbfDl').onclick = function () {
      var b = build();
      if (b.d14) downloadBytes(D14.name, b.d14);
      if (b.d20) setTimeout(function () { downloadBytes(D20.name, b.d20); }, 400);
      toast('已下載新的 D14 / D20，請用它們取代重測系統資料夾裡的原檔（建議先備份原檔）');
    };
    if ($('dbfWrite')) $('dbfWrite').onclick = function () { writeDbfToFolder(plan, build()); };
    $('dbfSaveDir').appendChild(makeSaveDirBtn());
  }

  function downloadBytes(name, u8) {
    var blob = new Blob([u8], { type: 'application/octet-stream' });
    if (saveDir) { saveBlob(name, blob, { key: name }); return; }
    browserDownload(name, blob);
  }

  function stampNow() {
    var d = new Date(), p2 = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes());
  }

  /** 選重測系統資料夾 → 先把原檔另存 .bak → 再寫入新檔 */
  function writeDbfToFolder(plan, built) {
    var jobs = [];
    if (built.d14) jobs.push({ src: state.dbf.D14, data: built.d14, n: plan.toD14.length });
    if (built.d20) jobs.push({ src: state.dbf.D20, data: built.d20, n: plan.toD20.length });
    if (!jobs.length) return;
    toast('請選擇 ' + jobs.map(function (j) { return j.src.name; }).join('、') + ' 所在的資料夾');
    window.showDirectoryPicker({ mode: 'readwrite' }).then(function (dir) {
      // 先確認資料夾裡的檔案就是剛剛放進來的那份（避免寫錯資料夾或檔案已被改過）
      return Promise.all(jobs.map(function (j) {
        return dir.getFileHandle(j.src.name).then(function (h) { return h.getFile().then(function (f) { return f.arrayBuffer(); }).then(function (buf) {
          var cur = new Uint8Array(buf);
          var same = cur.length === j.src.bytes.length && cur.every(function (v, i) { return v === j.src.bytes[i]; });
          if (!same) throw new Error('資料夾裡的 ' + j.src.name + ' 和剛剛放進來的不一樣（可能是別的資料夾，或檔案已經被改過）。請重新放入最新的檔案再寫入。');
          j.handle = h; j.orig = cur;
        }); }, function () { throw new Error('這個資料夾裡找不到 ' + j.src.name + '，請選重測系統放 D14、D20 的資料夾'); });
      })).then(function () {
        return jobs.reduce(function (p, j) {
          return p.then(function () {
            var bak = j.src.name + '.bak';
            return dir.getFileHandle(bak).then(function () { bak = j.src.name + '.' + stampNow() + '.bak'; }, function () {}).then(function () {
              return dir.getFileHandle(bak, { create: true });
            }).then(function (bh) {
              j.bak = bak;
              return bh.createWritable().then(function (w) { return w.write(j.orig).then(function () { return w.close(); }); });
            }).then(function () {
              return j.handle.createWritable().then(function (w) { return w.write(j.data).then(function () { return w.close(); }); });
            });
          });
        }, Promise.resolve());
      }).then(function () {
        var msg = jobs.map(function (j) { return j.src.name + ' 新增 ' + j.n + ' 筆（原檔備份成 ' + j.bak + '）'; }).join('；');
        state.dbfDone = esc(msg) + (plan.renumbered ? '；有 ' + plan.renumbered + ' 點自動改號，請看對照表' : '');
        jobs.forEach(function (j) { j.src.bytes = j.data; j.src.db = Core.parseDbf(j.data); });
        run(); // 重畫整頁：檔案筆數、完成訊息、下一步說明
        toast('已寫入重測系統檔');
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return;
      modal('<h3>沒有寫入</h3><p>' + esc(e && e.message || e) + '</p><p class="muted">原檔沒有被改動。</p><div style="text-align:right"><button class="btn primary" id="okW">好</button></div>');
      $('okW').onclick = closeModal;
    });
  }

  // ═════════════ GPS 點位檢查 ═════════════

  function setDecision(key, line, include) {
    var d = state.decisions[key] = state.decisions[key] || {};
    d[line] = include;
    run();
  }

  var REVIEW_MAX = 800;

  /** 點位檢查表的「寫入編碼」欄：要改編碼的點給輸入框，其他顯示文字 */
  function codeCell(p, q) {
    if (!q.include) return '';
    var editable = q.flags.indexOf('badcode') >= 0 || q.flags.indexOf('ask') >= 0 || q.codeFrom === 'manual';
    var v = q.useCode == null ? '' : q.useCode;
    if (!editable) return esc(v);
    return '<input class="pcode' + (q.codeFrom === 'pending' ? ' need' : '') + '" data-key="' + esc(p.key) + '" data-line="' + q.line + '" inputmode="numeric" maxlength="2" value="' + esc(v) + '" placeholder="??" title="00～99，留空恢復自動">';
  }
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
    // 需要你注意的排前面：待決定編碼 → 會轉換但有改動/疑慮 → 剔除的（同一級保持原檔順序）
    var rank = function (q) { return q.codeFrom === 'pending' ? 0 : (q.include && q.flags.length ? 1 : (q.include ? 2 : 3)); };
    if (f === 'flag' || f === 'all') {
      list = list.map(function (x, i) { return { x: x, i: i }; })
        .sort(function (a, b) { return (rank(a.x.q) - rank(b.x.q)) || (a.i - b.i); })
        .map(function (o) { return o.x; });
    }

    var cols = r.parts[0].cols || {};
    var h = '';
    // 沒有編碼但有高程的點：問使用者要編幾號
    r.parts.forEach(function (p) {
      var askPts = p.points.filter(function (q) { return q.include && q.flags.indexOf('ask') >= 0; });
      if (!askPts.length) return;
      var cur = state.askAs[p.key];
      var names = askPts.slice(0, 8).map(function (q) { return q.name; }).join('、') + (askPts.length > 8 ? '…' : '');
      var decided = cur != null && cur !== '';
      h += '<div class="askbox' + (decided ? ' done' : '') + '" data-key="' + esc(p.key) + '">' +
        '<div class="aq">' + (decided ? '✅' : '📝') + ' ' + (r.parts.length > 1 ? '【' + esc(p.source) + '】' : '') +
        '有 <b>' + askPts.length + '</b> 點沒有編碼但有高程（' + esc(names) + '），可能是現場收的點。<b>要編成幾號？</b></div>' +
        '<div class="aa"><span>編碼</span><input class="askcode" inputmode="numeric" maxlength="2" placeholder="00～99" value="' + esc(decided ? cur : '') + '">' +
        '<button class="btn primary small askok" type="button">' + (decided ? '更新' : '套用') + '</button>' +
        '<button class="btn small askskip" type="button">這些點不轉換</button>' +
        '<span class="muted">也可以在下面表格個別改。</span><span class="askerr"></span></div></div>';
    });
    h += '<p class="sum">檔案裡共 <b>' + all.length + '</b> 點：會轉換 <b style="color:var(--ok)">' + nInc + '</b> 點、剔除 <b style="color:var(--err)">' + nOff + '</b> 點' +
      (nFlag ? '；其中 <b>' + nFlag + '</b> 點系統覺得有疑慮（已先幫你決定，可以改）' : '；沒有發現可疑的點') + '。</p>' +
      '<p class="muted" style="margin:-4px 0 10px">欄位判斷：第 1 欄點名、第 ' + (cols.n + 1) + ' 欄 N、第 ' + (cols.e + 1) + ' 欄 E' + (cols.swapNE ? '（N、E 已對調）' : '') +
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
        (cols.h >= 0 ? '<th>高程</th>' : '') + '<th>原編碼</th><th>寫入編碼</th><th class="l">狀態</th><th>原檔行</th></tr></thead><tbody>';
      var lastSrc = null;
      list.slice(0, REVIEW_MAX).forEach(function (x) {
        var q = x.q;
        if (r.parts.length > 1 && x.p.source !== lastSrc) { lastSrc = x.p.source; h += '<tr class="station"><td class="l" colspan="9">' + esc(lastSrc) + '</td></tr>'; }
        var badges = q.flags.length ? q.reasons.map(function (t, k) {
          var hard = { junk: 1, check: 1, far: 1, dup: 1 }[q.flags[k]];
          var pend = q.flags[k] === 'ask' && q.codeFrom === 'pending';
          return '<span class="flagb ' + (hard ? 'x' : (pend ? 'w' : 'w')) + '">' + esc(t) + (pend ? '：待決定' : '') + '</span>';
        }).join('') : (q.supp ? '<span class="flagb ok">補點' + (q.renamedFrom ? '（原點號 ' + esc(q.renamedFrom) + '，名稱取自編碼 ' + esc(q.origCode) + '）' : '') + '</span>' : '<span class="flagb ok">正常</span>');
        h += '<tr class="' + (q.include ? '' : 'off') + '"><td class="c"><input type="checkbox" data-key="' + esc(x.p.key) + '" data-line="' + q.line + '" ' + (q.include ? 'checked' : '') + ' aria-label="轉換 ' + esc(q.name) + '"></td>' +
          '<td class="l mono">' + esc(q.name || '（無）') + '</td><td class="mono">' + esc(q.n) + '</td><td class="mono">' + esc(q.e) + '</td>' +
          (cols.h >= 0 ? '<td class="mono">' + esc(q.h) + '</td>' : '') + '<td class="mono">' + esc(q.code) + '</td><td class="mono">' + codeCell(x.p, q) + '</td><td class="l">' + badges + '</td><td>' + q.line + '</td></tr>';
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
    // 個別改編碼
    Array.prototype.forEach.call($('review').querySelectorAll('input.pcode'), function (c) {
      c.onchange = function () {
        var key = c.getAttribute('data-key'), line = +c.getAttribute('data-line'), v = c.value.trim();
        var m = state.codes[key] = state.codes[key] || {};
        if (v === '') { delete m[line]; run(); return; }
        if (!/^\d{1,2}$/.test(v)) { toast('編碼要是 00～99 的數字'); c.value = ''; return; }
        m[line] = v; run();
      };
    });
    // 統一編號
    Array.prototype.forEach.call($('review').querySelectorAll('.askbox'), function (box) {
      var key = box.getAttribute('data-key');
      var inp = box.querySelector('.askcode');
      var apply = function () {
        var v = inp.value.trim();
        if (!/^\d{1,2}$/.test(v)) { box.querySelector('.askerr').textContent = '請輸入 00～99 的數字'; inp.focus(); return; }
        state.askAs[key] = v.length === 1 ? '0' + v : v;
        run();
        toast('已把沒有編碼的點編成 ' + state.askAs[key]);
      };
      box.querySelector('.askok').onclick = apply;
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') apply(); });
      box.querySelector('.askskip').onclick = function () {
        var part = r.parts.filter(function (p) { return p.key === key; })[0];
        var d = state.decisions[key] = state.decisions[key] || {};
        part.points.forEach(function (q) { if (q.flags.indexOf('ask') >= 0) d[q.line] = false; });
        run();
      };
    });
    $('rvReset').onclick = function () { state.decisions = {}; state.codes = {}; state.askAs = {}; run(); };
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
      var sw = r.order === 'xy';
      h = '<table><thead><tr><th class="l">點號</th><th>' + (sw ? 'X' : 'Y') + '</th><th>' + (sw ? 'Y' : 'X') + '</th><th class="l">種類</th><th class="l">來源檔案</th></tr></thead><tbody>';
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
      b.onclick = function () { state.opts[key] = c[0]; saveOpts(); if (key === 'codeColumn' || key === 'neOrder') state.decisions = {}; run(); };
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
    var single = GROUPED[k] ? lGroups(state.inputs).length === 1 : state.inputs.length === 1;
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
      if (k === 'raw2mac') o.appendChild(seg('MAC 格式', 'macStyle', [['excel', 'Excel 版（預設）'], ['space', '空白分隔（舊 jar 版）']],
        'Excel 版和 Excel 轉檔工具存出來的一樣：Tab 分隔、去尾 0、數字點號後加一個空白。'));
      else o.appendChild(seg('欄位分隔', 'sep', [['space', '空白'], ['tab', 'Tab']], '重測系統兩種都能讀，通常不用改。'));
    }
    if (k === 'raw2mac') {
      o.appendChild(chk('一律輸出後視歸零檔（_Zero.mac）', 'alwaysZero', '預設只有在後視讀數不為 0 時才會產生。'));
    }
    if (k === 'csv2cntmac') {
      var maxCols = Math.max.apply(null, (state.result && state.result.parts || []).map(function (p) { return p.maxCols || 4; }).concat([4]));
      var ch = [['auto', '自動判斷'], [0, '沒有編碼']];
      for (var c = 4; c <= Math.min(maxCols, 7); c++) ch.push([c, '第 ' + c + ' 欄']);
      o.appendChild(seg('N、E 欄位順序', 'neOrder', [['auto', '自動判斷'], ['ne', '點名,N,E'], ['en', '點名,E,N']],
        '自動判斷：N 一定比 E 大很多（TWD97），第 2 欄比較小就當成「點名,E,N」並對調。'));
      o.appendChild(seg('編碼（CD 碼）在第幾欄', 'codeColumn', ch, '第 1 欄點名、第 2 欄 N、第 3 欄 E。控制器原始檔通常是「點名,N,E,高程,編碼」，編碼在第 5 欄。'));
      var bw = el('div', { 'class': 'opt' });
      bw.appendChild(el('label', { 'class': 'h', 'for': 'badTo' }, '編碼不是 00～99 時（例如 be73、q11）自動改成'));
      var bi = el('input', { type: 'text', id: 'badTo', maxlength: '2', inputmode: 'numeric' });
      bi.value = state.opts.badCodeTo || '11';
      bi.onchange = function () {
        var v = bi.value.trim();
        if (!/^\d{1,2}$/.test(v)) { toast('請輸入 00～99 的數字'); bi.value = state.opts.badCodeTo || '11'; return; }
        state.opts.badCodeTo = v.length === 1 ? '0' + v : v; saveOpts(); run();
      };
      bw.appendChild(bi);
      bw.appendChild(el('div', { 'class': 'hint' }, '重測系統只能吃 .00～.99，預設改成 11（參考點）。改過的點會列在「編碼對照表」。'));
      o.appendChild(bw);
      o.appendChild(seg('角度秒數的小數位', 'angleDecimals', [[0, '整數秒'], [1, '1 位'], [2, '2 位']],
        '整數秒與舊 Excel 版相同。反算誤差太大時可改 1 位（需確認重測系統可讀）。'));
      o.appendChild(seg('距離小數位', 'distDecimals', [[3, '3 位 (mm)'], [4, '4 位']]));
    }
    if (k === 'l2csv') {
      o.appendChild(chk('去掉點號後面的編碼', 'stripCode', '例如 1001.05 → 1001（.0、.00 一律會自動去掉）。'));
    }
  }

  // ─────────── 存檔 ───────────
  function blobOf(f) { return f.content instanceof Blob ? f.content : new Blob([f.content], { type: 'text/plain' }); }
  /** 下載：有設定存檔資料夾就直接存進去，否則交給瀏覽器（「下載」資料夾） */
  /**
   * 下載：有設定存檔資料夾就直接存進去（存完會回頭檢查），否則交給瀏覽器。
   * 回傳 Promise：{ ok, where, name, size } 或 { ok: false, reason }
   */
  function download(f, silent, browserOnly) {
    var key = f.origName || f.name;
    if (saveDir && !browserOnly) return saveBlob(f.name, blobOf(f), { silent: silent, key: key });
    browserDownload(f.name, blobOf(f));
    setSaveLog(key, 'browser', '⬇ ' + nowHM() + ' 已交給瀏覽器下載，請看瀏覽器右上角的下載圖示（沒看到檔案的話，看網址列右邊有沒有「已封鎖下載」）');
    if (!silent) toast('已交給瀏覽器下載 ' + f.name + '（在「下載」資料夾）');
    return Promise.resolve({ ok: true, where: 'browser', name: f.name });
  }

  function nowHM() { var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; }; return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  /** 全部下載：存進資料夾時一個接一個存，最後統一回報；交給瀏覽器時提醒「多個下載」可能被擋 */
  function downloadAll(files) {
    if (!saveDir) {
      files.forEach(function (f, i) { setTimeout(function () { download(f, true); }, i * 400); });
      toast('已交給瀏覽器下載 ' + files.length + ' 個檔案');
      setTimeout(function () {
        modal('<h3>已交給瀏覽器下載 ' + files.length + ' 個檔案</h3><p>請到瀏覽器的「下載」資料夾確認。</p>' +
          '<p class="muted">如果只有第一個檔案下載成功：瀏覽器可能擋下了「同時下載多個檔案」，請看網址列右邊有沒有「已封鎖」的圖示，按它選「允許」，再按一次全部下載。<br>' +
          '或設定「📁 存檔資料夾」，系統會直接存進資料夾，就不會被擋。</p>' +
          '<div style="text-align:right;margin-top:12px"><button class="btn primary" id="daOk">知道了</button></div>');
        $('daOk').onclick = closeModal;
      }, files.length * 400 + 300);
      return;
    }
    var results = [];
    files.reduce(function (p, f) {
      return p.then(function () { return saveBlob(f.name, blobOf(f), { silent: true, key: f.origName || f.name, batch: true }).then(function (r) { results.push(r); }); });
    }, Promise.resolve()).then(function () {
      var ok = results.filter(function (r) { return r.ok; }), bad = results.filter(function (r) { return !r.ok; });
      if (!bad.length) { toast('✓ ' + ok.length + ' 個檔案都存到「' + saveDir.name + '」了'); return; }
      modal('<h3>' + (ok.length ? '⚠ 有 ' + bad.length + ' 個檔案沒有存成功' : '❌ 檔案都沒有存成功') + '</h3>' +
        (ok.length ? '<p>✓ 已存好：' + ok.map(function (r) { return esc(r.name); }).join('、') + '</p>' : '') +
        '<ul class="report">' + bad.map(function (r) { return '<li class="error"><span class="lv">失敗</span><span>' + esc(r.name) + '：' + esc(r.reason) + '</span></li>'; }).join('') + '</ul>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px">' +
        '<button class="btn" id="baPick">📁 重新選資料夾</button><button class="btn" id="baBrowser">⬇ 失敗的改存到瀏覽器的「下載」</button>' +
        '<button class="btn primary" id="baRetry">🔁 失敗的再試一次</button></div>');
      $('baPick').onclick = function () { closeModal(); showSaveDirDialog(); };
      $('baBrowser').onclick = function () {
        closeModal();
        bad.forEach(function (r, i) { setTimeout(function () { browserDownload(r.name, r.blob); }, i * 400); });
        files.forEach(function (f) { if (bad.some(function (r) { return r.name === f.name; })) setSaveLog(f.origName || f.name, 'browser', '⬇ ' + nowHM() + ' 改交給瀏覽器下載'); });
      };
      $('baRetry').onclick = function () { closeModal(); downloadAll(files.filter(function (f) { return bad.some(function (r) { return r.name === f.name; }); })); };
    });
  }

  /** 每個檔案最近一次存檔的結果，顯示在檔案那一列 */
  var saveLog = {};
  function setSaveLog(key, kind, text) {
    saveLog[key] = { kind: kind, text: text };
    Array.prototype.forEach.call(document.querySelectorAll('.fstat'), function (n) {
      if (n.getAttribute('data-key') === key) { n.className = 'fstat ' + kind; n.textContent = text; }
    });
  }

  /** 把存檔失敗的原因翻成白話 */
  function explainSaveError(e, dirName) {
    var n = e && e.name, m = (e && e.message) || String(e);
    if (e && e.needGesture) return '瀏覽器要你再按一次「允許」，才能寫入「' + dirName + '」（重新打開系統後常見）。';
    if (n === 'NotFoundError') return '找不到資料夾「' + dirName + '」：可能被移動、改名、刪除，或隨身碟／網路磁碟已經拔掉或斷線。';
    if (n === 'NotAllowedError' || n === 'SecurityError') return '沒有寫入「' + dirName + '」的權限：可能按了「封鎖」或權限已過期。';
    if (n === 'NoModificationAllowedError' || n === 'InvalidStateError' || /lock|in use|being used/i.test(m)) return '檔案正被其他程式使用（例如用 Excel 或重測系統開著同名檔案），請先關掉再試。';
    if (n === 'QuotaExceededError' || /space|quota/i.test(m)) return '磁碟空間不足。';
    if (e && e.verify) return '寫入後檢查發現檔案大小不對（應為 ' + e.expected + ' bytes，實際 ' + e.actual + ' bytes），檔案可能沒存完整。';
    return '寫入失敗：' + m;
  }

  function showSaveFail(name, blob, reason, retry, key) {
    modal('<h3>❌ 沒有存成功：' + esc(name) + '</h3><p>' + esc(reason) + '</p><p class="muted">檔案還沒存好，請選下面一個方式：</p>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px">' +
      '<button class="btn" id="sfPick">📁 重新選資料夾</button>' +
      '<button class="btn" id="sfBrowser">⬇ 改存到瀏覽器的「下載」</button>' +
      '<button class="btn primary" id="sfRetry">🔁 再試一次</button></div>');
    $('sfRetry').onclick = function () { closeModal(); retry(); };
    $('sfBrowser').onclick = function () {
      closeModal(); browserDownload(name, blob); toast('已交給瀏覽器下載 ' + name);
      setSaveLog(key || name, 'browser', '⬇ ' + nowHM() + ' 改交給瀏覽器下載，請看瀏覽器右上角的下載圖示');
    };
    $('sfPick').onclick = function () { closeModal(); showSaveDirDialog(); };
  }
  function browserDownload(name, blob) {
    var a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  // ═════════════ 存檔位置（每份系統各記各的資料夾） ═════════════

  var saveDir = null;
  // 用這份 HTML 所在的資料夾當鑰匙：複製到不同地方的系統會各自記住自己的存檔位置
  var HERE = (function () { try { return decodeURIComponent(location.pathname.replace(/[^\/]*$/, '')); } catch (e) { return location.pathname; } })();
  var PICK_ID = 'd' + (function (str) { var h = 5381; for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0; return h.toString(36); })(HERE);

  function idbStore(mode, fn) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no indexedDB')); return; }
      var req = indexedDB.open('chsys', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('dirs'); };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        try {
          var tx = req.result.transaction('dirs', mode), st = tx.objectStore('dirs');
          var r = fn(st);
          tx.oncomplete = function () { resolve(r && r.result); };
          tx.onerror = function () { reject(tx.error); };
        } catch (e) { reject(e); }
      };
    });
  }
  function loadSaveDir() {
    idbStore('readonly', function (st) { return st.get(HERE); }).then(function (h) {
      if (h && h.getFileHandle) { saveDir = h; renderSaveBtn(); if (state.result) renderResult(); }
    }).catch(function () {});
  }
  function rememberSaveDir(h) {
    saveDir = h; fileSpot = null; renderSaveBtn();
    if (h) addKnownDir(h);
    if (state.result && !$('resultArea').classList.contains('hidden')) renderResult();
    idbStore('readwrite', function (st) { return h ? st.put(h, HERE) : st.delete(HERE); }).catch(function () {});
  }
  /**
   * 記住用過的資料夾（選過、拖進來過、存過的）。之後拖進來的「檔案」如果在這些資料夾裡，
   * 就能找出它所在的資料夾，自動存回去（瀏覽器不會直接告訴網頁檔案在哪個資料夾）。
   */
  var KNOWN_KEY = 'known-dirs';
  function loadKnownDirs() {
    return idbStore('readonly', function (st) { return st.get(KNOWN_KEY); }).then(function (l) { return Array.isArray(l) ? l.filter(function (h) { return h && h.resolve; }) : []; }).catch(function () { return []; });
  }
  function addKnownDir(h) {
    if (!h || !h.isSameEntry) return Promise.resolve();
    return loadKnownDirs().then(function (list) {
      return Promise.all(list.map(function (x) { return x.isSameEntry(h).catch(function () { return false; }); })).then(function (same) {
        var keep = list.filter(function (x, i) { return !same[i]; });
        keep.unshift(h);
        return idbStore('readwrite', function (st) { return st.put(keep.slice(0, 20), KNOWN_KEY); });
      });
    }).catch(function () {});
  }
  function dirAt(root, segs) {
    return segs.reduce(function (p, seg) { return p.then(function (d) { return d.getDirectoryHandle(seg); }); }, Promise.resolve(root));
  }

  /** 拖進來（或用選檔視窗選）的檔案：找出它所在的資料夾 */
  var fileSpot = null; // { fh, root, path } 已知資料夾但還要按一下允許；{ fh } 不知道在哪
  function locateFiles(fhs) {
    var fh = (fhs || []).filter(function (h) { return h && h.kind === 'file'; })[0];
    if (!fh) return;
    loadKnownDirs().then(function (list) {
      if (saveDir && saveDir.resolve) list.unshift(saveDir);
      var i = 0;
      var tryNext = function () {
        if (i >= list.length) return null;
        var d = list[i++];
        return d.resolve(fh).then(function (path) { return path ? { root: d, path: path } : tryNext(); }, tryNext);
      };
      return tryNext();
    }).then(function (hit) {
      if (!hit) { fileSpot = { fh: fh }; refreshSaveUi(); return; }
      var segs = hit.path.slice(0, -1);
      // 已經就是存檔資料夾
      if (hit.root === saveDir && !segs.length) { fileSpot = null; refreshSaveUi(); return; }
      var q = hit.root.queryPermission ? hit.root.queryPermission({ mode: 'readwrite' }) : Promise.resolve('granted');
      return q.then(function (perm) {
        if (perm !== 'granted') { fileSpot = { fh: fh, root: hit.root, path: hit.path }; refreshSaveUi(); return; }
        return dirAt(hit.root, segs).then(function (sub) { switchToFileDir(sub); });
      });
    }).catch(function () { fileSpot = { fh: fh }; refreshSaveUi(); });
  }
  function switchToFileDir(sub) {
    fileSpot = null;
    var changed = !saveDir || saveDir.name !== sub.name;
    rememberSaveDir(sub);
    if (changed) toast('下載會直接存到「' + sub.name + '」（檔案所在的資料夾）');
  }
  function refreshSaveUi() { renderSaveBtn(); if (state.result && !$('resultArea').classList.contains('hidden')) renderResult(); }
  /** 一鍵：存到檔案所在的資料夾 */
  function useFileSpot() {
    var sp = fileSpot; if (!sp) return;
    if (sp.root) {
      ensurePermission(sp.root).then(function () { return dirAt(sp.root, sp.path.slice(0, -1)); })
        .then(switchToFileDir).catch(function (e) { toast('沒辦法切換：' + (e.message || e)); });
      return;
    }
    // 不知道在哪：打開選資料夾視窗，直接停在檔案所在的位置，按「選取資料夾」就好
    window.showDirectoryPicker({ startIn: sp.fh, mode: 'readwrite' }).then(function (h) {
      return h.resolve(sp.fh).then(function (p) {
        switchToFileDir(h);
        if (!p) toast('已設定存到「' + h.name + '」（注意：剛剛的檔案不在這個資料夾裡）');
      });
    }).catch(function (e) { if (e && e.name !== 'AbortError') toast('選資料夾失敗：' + e.message); });
  }

  function ensurePermission(h) {
    var o = { mode: 'readwrite' };
    if (!h.queryPermission) return Promise.resolve(true);
    return h.queryPermission(o).then(function (p) {
      if (p === 'granted') return true;
      return h.requestPermission(o).then(function (q) {
        if (q !== 'granted') { var err = new Error('權限被拒絕'); err.name = 'NotAllowedError'; throw err; }
        return true;
      }, function (e) {
        // 「需要使用者操作」：要在按鈕裡再要一次權限
        if (e && (e.name === 'SecurityError' || /activation|gesture/i.test(e.message || ''))) { var g = new Error(e.message); g.needGesture = true; throw g; }
        throw e;
      });
    });
  }
  /**
   * 存進設定的資料夾；同名檔案已存在時改名成「名稱 (1).副檔名」，不會蓋掉舊檔。
   * 存完會重新讀一次檔案大小確認真的存好；失敗會跳窗說明原因（opt.batch 時改由呼叫端統一回報）。
   */
  function saveBlob(name, blob, opt) {
    opt = opt || {};
    var h = saveDir, key = opt.key || name;
    var retry = function () { return saveBlob(name, blob, opt); };
    return ensurePermission(h).then(function () {
      var dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
      var tryName = function (i) {
        var nm = i ? stem + ' (' + i + ')' + ext : name;
        return h.getFileHandle(nm).then(function () { return i < 99 ? tryName(i + 1) : nm; }, function () { return nm; });
      };
      return tryName(0).then(function (nm) {
        return h.getFileHandle(nm, { create: true }).then(function (fh) {
          return fh.createWritable().then(function (w) { return w.write(blob).then(function () { return w.close(); }); })
            .then(function () { return fh.getFile ? fh.getFile() : null; })
            .then(function (f) {
              if (f && f.size !== blob.size) { var v = new Error('size'); v.verify = true; v.expected = blob.size; v.actual = f.size; throw v; }
              return nm;
            });
        });
      });
    }).then(function (nm) {
      var msg = '✓ ' + nowHM() + ' 已存好：「' + h.name + '」裡的 ' + nm + '（' + fmtSize(blob.size) + '）';
      setSaveLog(key, 'ok', msg);
      if (!opt.silent || nm !== name) toast('✓ 已存到「' + h.name + '」：' + nm);
      return { ok: true, where: h.name, name: nm, size: blob.size };
    }, function (e) {
      var reason = explainSaveError(e, h && h.name);
      setSaveLog(key, 'fail', '❌ ' + nowHM() + ' 沒有存成功：' + reason);
      if (!opt.batch) showSaveFail(name, blob, reason, retry, key);
      return { ok: false, name: name, reason: reason, retry: retry, blob: blob };
    });
  }

  /**
   * 選或拖進來的資料夾：直接設成存檔資料夾（之後按下載就存回這個資料夾），
   * 不會一直沿用上次存的資料夾。要存到別處可以按「📁 存到：…（更改）」。
   */
  var pendingDir = null;
  function considerSaveDir(h) {
    if (!h || !h.getFileHandle) return;
    pendingDir = null;
    var changed = !saveDir || saveDir.name !== h.name;
    rememberSaveDir(h); // 同名但不同位置的資料夾也要換成這一個
    if (changed) toast('下載會直接存到「' + h.name + '」（剛剛選的資料夾）');
  }

  /** 下載按鈕旁邊的「存到哪裡」按鈕 */
  function makeSaveDirBtn() {
    if (fileSpot && window.showDirectoryPicker) {
      var w2 = el('span', { 'class': 'savedirs' });
      var q2 = el('button', { 'class': 'btn savedir quick', type: 'button', title: '下載存到剛剛放進來的檔案所在的資料夾' },
        '📁 存到「<b>' + esc(fileSpot.fh.name) + '</b>」所在的資料夾' + (fileSpot.root ? '' : '<span class="muted" style="font-weight:400">（第一次要確認）</span>'));
      q2.onclick = useFileSpot;
      w2.appendChild(q2); w2.appendChild(makeSaveDirBtnPlain());
      return w2;
    }
    if (pendingDir && (!saveDir || saveDir.name !== pendingDir.name)) {
      var wrap = el('span', { 'class': 'savedirs' });
      var quick = el('button', { 'class': 'btn savedir quick', type: 'button', title: '把下載存到剛剛選的資料夾' }, '📁 存到剛剛選的「<b>' + esc(pendingDir.name) + '</b>」');
      quick.onclick = function () { var h = pendingDir; pendingDir = null; rememberSaveDir(h); toast('之後按下載會直接存到「' + h.name + '」'); };
      wrap.appendChild(quick);
      wrap.appendChild(makeSaveDirBtnPlain());
      return wrap;
    }
    return makeSaveDirBtnPlain();
  }
  function makeSaveDirBtnPlain() {
    var b = el('button', { 'class': 'btn savedir' + (saveDir ? ' set' : ''), type: 'button', title: '按下載時要存到哪裡；點一下可以更改' },
      saveDir ? '📁 存到：<b>' + esc(saveDir.name) + '</b>（更改）' : '📁 選擇存檔資料夾（目前存到瀏覽器的「下載」）');
    b.onclick = showSaveDirDialog;
    return b;
  }

  /** 點檔名改檔名（沒打副檔名會自動補回原本的副檔名） */
  function bindRename(span, f) {
    var start = function () {
      var inp = el('input', { type: 'text', 'class': 'fnedit', value: f.name, 'aria-label': '新檔名' });
      span.replaceWith(inp);
      inp.focus();
      var dot = f.name.lastIndexOf('.');
      inp.setSelectionRange(0, dot > 0 ? dot : f.name.length);
      var done = false;
      var commit = function (save) {
        if (done) return; done = true;
        var v = inp.value.trim().replace(/[\\/:*?"<>|]/g, '_');
        if (save && v) {
          var ext = f.origName.slice(f.origName.lastIndexOf('.'));
          if (f.origName.lastIndexOf('.') > 0 && v.toLowerCase().slice(-ext.length) !== ext.toLowerCase()) v += ext;
          if (v === f.origName) delete state.fileRenames[f.origName]; else state.fileRenames[f.origName] = v;
          if (v !== f.name) toast('檔名改成 ' + v);
        }
        run();
      };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
      inp.addEventListener('blur', function () { commit(true); });
    };
    span.addEventListener('click', start);
    span.addEventListener('keydown', function (e) { if (e.key === 'Enter') start(); });
  }

  function renderSaveBtn() {
    var b = $('btnSaveDir');
    if (!b) return;
    b.textContent = saveDir ? '📁 存到：' + saveDir.name : '⬇ 存到：下載資料夾';
    b.title = saveDir ? '按下載會直接存到「' + saveDir.name + '」（點一下可更改）' : '目前存到瀏覽器的「下載」資料夾（點一下可改成指定資料夾）';
  }

  function showSaveDirDialog() {
    if (!window.showDirectoryPicker) {
      modal('<h3>存檔位置</h3><p>這個瀏覽器不支援直接存到指定資料夾，請改用 <b>Chrome</b> 或 <b>Edge</b>。</p>' +
        '<p class="muted">或在瀏覽器設定裡打開「下載前詢問每個檔案的儲存位置」，每次下載時自己選。</p><div style="text-align:right"><button class="btn primary" id="sdOk">好</button></div>');
      $('sdOk').onclick = closeModal;
      return;
    }
    modal('<h3>存檔位置</h3>' +
      '<p>目前：' + (saveDir ? '<b>📁 ' + esc(saveDir.name) + '</b>（按下載會直接存進去）' : '<b>瀏覽器的「下載」資料夾</b>') + '</p>' +
      '<div class="sdrecent" id="sdRecent"></div>' +
      '<p>這份系統放在：<br><code class="mono" style="word-break:break-all">' + esc(HERE) + '</code></p>' +
      '<p class="muted">小技巧：選資料夾或把資料夾拖進來，就會自動存回那個資料夾；拖進來的是檔案時，如果檔案在用過的資料夾裡，也會自動存回檔案所在的資料夾。</p>' +
      '<ol class="next"><li><div>按下面的「📁 選資料夾」，到<b>上面這個位置</b>選資料夾（要存到別的地方也可以）。</div></li>' +
      '<li><div>之後在這份系統按「⬇ 下載」都會<b>直接存進那個資料夾</b>；同名檔案已存在時會自動加上 (1)、(2)，不會蓋掉。</div></li>' +
      '<li><div>每一份複製到不同位置的系統<b>各自記住自己的資料夾</b>。重新打開時瀏覽器可能會問一次「允許編輯檔案」，按允許即可。</div></li></ol>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px">' +
      (saveDir ? '<button class="btn" id="sdReset">改回瀏覽器下載資料夾</button>' : '') +
      '<button class="btn" id="sdCancel">取消</button><button class="btn primary" id="sdPick">📁 選資料夾</button></div>');
    $('sdCancel').onclick = closeModal;
    // 用過的資料夾：一鍵切換
    loadKnownDirs().then(function (list) {
      if (!list.length || !$('sdRecent')) return;
      var box = $('sdRecent');
      box.innerHTML = '<div class="lbl">用過的資料夾（點一下就切換）：</div>';
      list.slice(0, 10).forEach(function (h) {
        var cur = saveDir && saveDir.name === h.name;
        var bt = el('button', { 'class': 'btn small' + (cur ? ' primary' : ''), type: 'button' }, '📁 ' + esc(h.name));
        bt.onclick = function () {
          ensurePermission(h).then(function () { rememberSaveDir(h); closeModal(); toast('之後按下載會直接存到「' + h.name + '」'); })
            .catch(function (e) { toast('沒辦法使用「' + h.name + '」：' + (e.message || e)); });
        };
        box.appendChild(bt);
      });
    });
    if ($('sdReset')) $('sdReset').onclick = function () { rememberSaveDir(null); closeModal(); toast('改回存到瀏覽器的「下載」資料夾'); };
    $('sdPick').onclick = function () {
      window.showDirectoryPicker({ id: PICK_ID, mode: 'readwrite' }).then(function (h) {
        rememberSaveDir(h); closeModal(); toast('之後按下載會直接存到「' + h.name + '」');
      }).catch(function (e) { if (e && e.name !== 'AbortError') toast('選資料夾失敗：' + e.message); });
    };
  }
  $('btnSaveDir').onclick = showSaveDirDialog;
  renderSaveBtn();
  loadSaveDir();


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


  $('btnAbout').onclick = function () {
    modal('<div class="about"><h3>使用說明</h3>' +
      '<p>三個步驟：<b>① 放入檔案（或選整個資料夾）→ ② 看縮圖和紅色/黃色提醒 → ③ 按綠色「下載」</b>。檔案只在你的電腦上處理，不會上傳。</p>' +
      '<table><thead><tr><th>功能</th><th>放入</th><th>得到</th></tr></thead><tbody>' +
      '<tr><td>全站儀 → 重測系統</td><td>Nikon .RAW</td><td>.mac（必要時加 _Zero.mac）</td></tr>' +
      '<tr><td>GPS → 重測系統</td><td>控制器輸出的 .CSV（會自動剔除核對點、雜點）</td><td>.cnt（點號.編碼,Y,X）；有 D14、D20 時直接寫入</td></tr>' +
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
    folderDbf = g.dbf || [];
    var ignoredNote = (g.ignored || []).length ? '（已略過系統預設檔 KC0000.L02' + (g.ignored.length > 1 ? ' 共 ' + g.ignored.length + ' 個' : '') + '）' : '';
    // 複丈輸入檔：資料夾裡沒有 L02/L14/L20 時才列出（或已在角落按鈕手動啟用）
    var useCoa = g.coa2csv.length && (!g.l2csv.length || state.coaEnabled || state.kind === 'coa2csv');
    var ALL = ['l2csv', 'raw2mac', 'csv2cntmac'].concat(useCoa ? ['coa2csv'] : []);
    if (!useCoa) g.coa2csv = [];
    var kinds = state.kind === 'basemap' ? [] : state.kind ? [state.kind] : ALL;
    // 輸出航照圖頁面：直接用資料夾裡的 L 檔
    if (state.kind === 'basemap' && g.l2csv.length === 1) { loadGroups([g.l2csv[0]], 'basemap', null); return; }
    // 目前頁面要的檔案在資料夾裡沒有，但有其他種類：列出來讓使用者改做那一種
    if (state.kind && state.kind !== 'basemap' && !g[state.kind].length && ALL.some(function (k) { return g[k].length; })) {
      kinds = ALL;
      toast('資料夾裡沒有這個轉換要用的檔案，以下是找到的其他資料');
    }
    var total = kinds.reduce(function (n, k) { return n + g[k].length; }, 0);
    var bmOpt = g.l2csv.length > 0; // 有 L02/L14/L20 就多一個「其他：輸出航照圖」
    if (!total && !bmOpt) {
      modal('<h3>資料夾裡沒有找到可以轉換的檔案</h3><p class="muted">「' + esc(folderName) + '」裡共 ' + entries.length + ' 個檔案，沒有 ' +
        (state.kind === 'l2csv' || state.kind === 'basemap' ? '.L02 / .L14 / .L20' : state.kind === 'raw2mac' ? '.RAW' : state.kind === 'csv2cntmac' ? '.CSV' : state.kind === 'coa2csv' ? '.COA' : '.RAW、.CSV、.L02 / .L14 / .L20') + '。' + ignoredNote + '</p>' +
        '<div style="text-align:right"><button class="btn primary" id="ok1">好</button></div>');
      $('ok1').onclick = closeModal;
      return;
    }
    // 只有一項：直接開始（重測資料有兩種以上時還是要讓使用者選要匯入哪些）
    var single = total === 1 ? g[kinds.filter(function (k) { return g[k].length; })[0]] : null;
    if (total === 1 && !bmOpt) {
      var k1 = kinds.filter(function (k) { return g[k].length; })[0];
      loadGroups([g[k1][0]], k1, null);
      return;
    }
    // ── 選擇要做什麼：和首頁一樣的卡片，點一下就開始 ──
    var GROUPS = [
      { tag: '匯出', cls: 'out', title: '重測系統 → 外業儀器', kinds: ['l2csv', 'coa2csv'] },
      { tag: '匯入', cls: 'in', title: '外業資料 → 重測系統', kinds: ['raw2mac', 'csv2cntmac'] },
      { tag: '其他', cls: 'other', title: '參考圖資', kinds: ['basemap'] }
    ];
    var found = { basemap: bmOpt ? g.l2csv : [] };
    kinds.forEach(function (k) { found[k] = g[k]; });
    var homeCard = function (k) { return document.querySelector('#home .card[data-kind=' + k + ']'); };
    var extBadges = function (item, exts) { return exts.map(function (e) { return '<span class="extb' + (item.exts.indexOf(e) < 0 ? ' miss' : '') + '">' + e + '</span>'; }).join(''); };
    var itemText = function (k, item) {
      if (k === 'l2csv' || k === 'basemap') return '<b>' + esc(item.label) + '</b> ' + extBadges(item, ['L02', 'L14', 'L20']);
      if (k === 'coa2csv') return '<b>' + esc(item.label) + '</b> ' + extBadges(item, ['COA', 'CTL', 'BNP', 'PAR']);
      return '<b>' + esc(item.label) + '</b>';
    };
    var hasDbf = (g.dbf || []).length > 0;
    var EXTRA = {
      l2csv: '控制點、界址點、補點合併成一個坐標檔，放樣用',
      coa2csv: '界址點＋控制點，可依地號挑點',
      raw2mac: '每個 RAW 各自產生 .mac',
      csv2cntmac: hasDbf ? '資料夾裡有 D14、D20：可以直接寫入重測系統' : '自動整理雜點，產生 .cnt',
      basemap: '依點位範圍抓正射影像並置中，可選套合點校正偏差'
    };
    var h = '<h3>在「' + esc(folderName) + '」找到這些資料，要做什麼？</h3><div class="muted">點一下卡片就開始。' + ignoredNote + '</div>';
    GROUPS.forEach(function (G) {
      var ks = G.kinds.filter(function (k) { return found[k] && found[k].length; });
      if (!ks.length) return;
      h += '<div class="fgrp ' + G.cls + '"><h4><span class="tag">' + G.tag + '</span>' + G.title + '</h4>';
      ks.forEach(function (k) {
        var hc = homeCard(k), list = found[k], multi = list.length > 1;
        h += '<div class="card fcard" role="button" tabindex="0" data-k="' + k + '"><span class="ico">' + (hc ? hc.querySelector('.ico').innerHTML : '') + '</span><span class="fbody">' +
          '<span class="t">' + esc(KINDS[k].title.replace('（JPG + JGW）', '')) + '</span>' +
          '<span class="d">' + esc(EXTRA[k]) + '</span>' +
          (multi ? '<span class="fitems">' + list.map(function (item, ii) {
            return '<label class="fitem"><input type="checkbox" data-i="' + ii + '" checked><span>' + itemText(k, item) + (item.dir && item.dir !== folderName ? ' <span class="muted">📁 ' + esc(item.dir) + '</span>' : '') + '</span></label>';
          }).join('') + '</span>'
            : '<span class="flow">' + itemText(k, list[0]) + '</span>') +
          '</span><span class="fgo">' + (multi ? '開始（<b class="fn">' + list.length + '</b>）' : '開始') + ' →</span></div>';
      });
      h += '</div>';
    });
    h += '<div style="text-align:right;margin-top:14px"><button class="btn" id="fCancel">取消</button></div>';
    modal(h, true);
    $('fCancel').onclick = closeModal;
    Array.prototype.forEach.call($('modalBox').querySelectorAll('.fcard'), function (card) {
      var k = card.getAttribute('data-k'), list = found[k];
      var boxes = card.querySelectorAll('input[data-i]');
      var picked = function () { return boxes.length ? Array.prototype.filter.call(boxes, function (b) { return b.checked; }).map(function (b) { return list[+b.getAttribute('data-i')]; }) : [list[0]]; };
      Array.prototype.forEach.call(boxes, function (b) {
        b.onclick = function (e) { e.stopPropagation(); };
        b.onchange = function () { var n = picked().length; card.querySelector('.fn').textContent = n; card.classList.toggle('dis', !n); };
      });
      Array.prototype.forEach.call(card.querySelectorAll('.fitem'), function (l) { l.onclick = function (e) { e.stopPropagation(); }; });
      var go = function () { var pk = picked(); if (!pk.length) { toast('請至少勾一個'); return; } loadGroups(pk, k, null); };
      card.onclick = go;
      card.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
  }


  /** 讀取勾選的項目並開始轉換 */
  var folderDbf = [];
  function loadGroups(groups, kind, keepTypes) {
    var files = [].concat.apply([], groups.map(function (gr) {
      return gr.files.filter(function (f) { return !keepTypes || keepTypes.indexOf(Core.extName(f.name)) >= 0; })
        .map(function (f) { return { file: f.file, path: f.path }; });
    }));
    // GPS／全站儀：資料夾裡有 D14、D20 時一起讀進來（優先同一個資料夾）
    // 其他轉換：只帶 D14（航照底圖用 87 航照判讀點校正偏差）
    if (folderDbf.length) {
      var dir = groups.length ? groups[0].dir : '';
      (DBF_KINDS[kind] ? ['D14', 'D20'] : ['D14']).forEach(function (e) {
        var cands = folderDbf.filter(function (d) { return d.ext === e; });
        var pick = cands.filter(function (d) { return d.dir === dir; })[0] || (cands.length === 1 ? cands[0] : null);
        if (pick) files.push({ file: pick.files[0].file, path: pick.files[0].path });
      });
    }
    readFiles(files).then(function (inputs) {
      closeModal();
      if (state.kind !== kind) openKind(kind);
      bmD14 = null;
      mergeInputs(inputs);
      run();
    });
  }

  /** 同路徑的檔案取代，其餘加入 */
  var DBF_KINDS = { raw2mac: 1, csv2cntmac: 1 };
  function mergeInputs(files) {
    files = files.filter(function (f) {
      var ext = Core.extName(f.name);
      if ((ext === 'D14' || ext === 'D20') && DBF_KINDS[state.kind]) { attachDbf(f); return false; }
      if (ext === 'D14' || ext === 'D20') { if (ext === 'D14') stashBmD14(f); return false; }
      return true;
    });
    files.forEach(function (f) {
      var i = state.inputs.findIndex(function (x) { return inputKey(x) === inputKey(f); });
      if (i >= 0) state.inputs[i] = f; else state.inputs.push(f);
    });
  }

  // ─────────── 拖放／選檔 ───────────

  /**
   * 拖放：支援直接拖資料夾進來（遞迴讀取）。
   * 直接雙擊開啟的網頁（file://）在 Chrome / Edge 不能用舊的 webkitGetAsEntry 讀資料夾內容，
   * 所以先用新的 getAsFileSystemHandle，不行再退回舊方法；都被擋時回傳 blocked。
   */
  function collectDropped(dt) {
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    var plainFiles = Array.prototype.slice.call(dt.files || []);
    // 這兩個都必須在 drop 事件當下同步呼叫
    var entries = items.map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; });
    var handleProms = items.map(function (it) {
      if (it.kind !== 'file' || !it.getAsFileSystemHandle) return Promise.resolve(null);
      try { return it.getAsFileSystemHandle().catch(function () { return null; }); } catch (e) { return Promise.resolve(null); }
    });
    var dirEntry = entries.filter(function (e) { return e && e.isDirectory; })[0];
    if (!dirEntry) return Promise.all(handleProms).then(function (hs) { return { files: plainFiles, folder: null, fileHandles: hs }; }, function () { return { files: plainFiles, folder: null }; });
    var dirName = dirEntry.name;

    var dirHandle = null;
    return Promise.all(handleProms)
      .then(function (handles) {
        dirHandle = handles.filter(function (h) { return h && h.kind === 'directory'; })[0] || null;
        if (!dirHandle) return [];
        return walkHandles(handles).catch(function () { return []; });
      })
      .then(function (out) { return out.length ? out : walkEntries(entries.filter(Boolean)); })
      .then(function (out) { return { files: out, folder: dirName, blocked: !out.length, dirHandle: dirHandle }; });
  }

  /** 新方法（File System Access API）：逐層讀資料夾 */
  async function walkHandles(handles) {
    var out = [];
    async function walk(h, prefix) {
      if (h.kind === 'file') {
        out.push({ file: await h.getFile(), path: prefix + h.name });
      } else if (h.kind === 'directory') {
        for await (var child of h.values()) await walk(child, prefix + h.name + '/');
      }
    }
    for (var i = 0; i < handles.length; i++) if (handles[i]) await walk(handles[i], '');
    return out;
  }

  /** 舊方法（webkitGetAsEntry），網頁從 http 開啟時可用 */
  function walkEntries(entries) {
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
    return Promise.all(entries.map(walk)).then(function () { return out; });
  }

  /** 瀏覽器不讓網頁讀拖進來的資料夾時：說明並提供一鍵改用「選資料夾」 */
  function dropBlocked(folder) {
    modal('<h3>瀏覽器不讓網頁讀取拖進來的「' + esc(folder) + '」資料夾</h3>' +
      '<p>這是 Chrome / Edge 對「直接從電腦打開的網頁」的安全限制，不是檔案的問題，檔案也沒有上傳到任何地方。</p>' +
      '<p>請改用下面兩種方法之一：</p><ol class="next">' +
      '<li><div>按下面的藍色按鈕，選同一個「' + esc(folder) + '」資料夾（最簡單）。</div></li>' +
      '<li><div>打開資料夾，按 <b>Ctrl + A</b> 全選裡面的檔案，再把<b>檔案</b>（不是資料夾）拖進來。</div></li></ol>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" id="dbCancel">取消</button>' +
      '<button class="btn primary" id="dbPick">📁 選擇「' + esc(folder) + '」資料夾</button></div>');
    $('dbCancel').onclick = closeModal;
    $('dbPick').onclick = function () { closeModal(); $('dirInput').value = ''; $('dirInput').click(); };
  }

  var pickTarget = 'home';
  function bindDrop(zone, target) {
    zone.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button')) return;
      pickTarget = target;
      if (window.showOpenFilePicker) {
        var acc = (target === 'work' && state.kind ? KINDS[state.kind].accept : '.raw,.csv,.txt,.asc,.l02,.l14,.l20,.coa,.ctl,.bnp,.par,.d14,.d20').split(',');
        window.showOpenFilePicker({ multiple: true, id: PICK_ID, types: [{ description: '資料檔', accept: { 'application/octet-stream': acc } }] }).then(function (hs) {
          return Promise.all(hs.map(function (h) { return h.getFile(); })).then(function (fs) { handleFiles(fs); locateFiles(hs); });
        }).catch(function (e) {
          if (e && e.name === 'AbortError') return;
          $('fileInput').value = ''; $('fileInput').click();
        });
        return;
      }
      $('fileInput').value = ''; $('fileInput').click();
    });
    zone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); zone.click(); } });
  }
  bindDrop($('homeDrop'), 'home');
  bindDrop($('workDrop'), 'work');

  // 整個視窗都可以放檔案／資料夾（不必剛好放在虛線框裡）
  var dragDepth = 0;
  var isFileDrag = function (e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
  };
  var showOverlay = function (on) { $('dropOverlay').classList.toggle('hidden', !on); };
  window.addEventListener('dragenter', function (e) {
    if (!isFileDrag(e)) return;
    e.preventDefault(); dragDepth++; showOverlay(true);
  });
  window.addEventListener('dragover', function (e) {
    e.preventDefault();
    if (isFileDrag(e)) { e.dataTransfer.dropEffect = 'copy'; showOverlay(true); }
  });
  window.addEventListener('dragleave', function (e) {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) showOverlay(false);
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0; showOverlay(false);
    if (!e.dataTransfer) return;
    collectDropped(e.dataTransfer).then(function (res) {
      if (res.blocked) dropBlocked(res.folder);
      else if (res.folder) { considerSaveDir(res.dirHandle, res.files); handleFolder(res.files, res.folder); }
      else if (res.files.length) { handleFiles(res.files); locateFiles(res.fileHandles); }
      else toast('沒有讀到檔案，請改用「📁 選資料夾」按鈕');
    }).catch(function (err) {
      toast('讀取拖入的檔案失敗，請改用「📁 選資料夾」按鈕（' + (err && err.message || err) + '）');
    });
  });
  $('fileInput').addEventListener('change', function () { if (this.files.length) handleFiles(this.files); });

  var openDir = function () {
    if (!window.showDirectoryPicker) { $('dirInput').value = ''; $('dirInput').click(); return; }
    // 用 Chrome/Edge 的資料夾選擇：讀檔之外也能拿到存檔權限（選的資料夾裡有這份系統就直接當存檔位置）
    window.showDirectoryPicker({ id: PICK_ID, mode: 'readwrite' }).then(function (h) {
      toast('讀取「' + h.name + '」中…');
      return walkHandles([h]).then(function (files) {
        considerSaveDir(h, files);
        handleFolder(files, h.name);
      });
    }).catch(function (e) {
      if (e && e.name === 'AbortError') return;
      // 不能用新方法時退回舊的選資料夾
      $('dirInput').value = ''; $('dirInput').click();
    });
  };
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
      var dbfs = [];
      files.forEach(function (f) {
        var k = Core.detectKind(f.name, f.text);
        if (k === 'dbf') dbfs.push(f);
        else if (k) (kinds[k] = kinds[k] || []).push(f); else unknown.push(f.name);
      });
      var ks = Object.keys(kinds);
      if (!ks.length && dbfs.length) {
        modal('<h3>收到重測系統檔 ' + esc(dbfs.map(function (f) { return f.name; }).join('、')) + '</h3>' +
          '<p>D14、D20 是用來把 <b>GPS 的 CSV</b> 或 <b>全站儀的 RAW</b> 直接寫進重測系統的。請把 CSV 或 RAW 和 D14、D20 <b>一起</b>拖進來（或選整個資料夾）。</p>' +
          '<div style="text-align:right"><button class="btn primary" id="ok1">好</button></div>');
        $('ok1').onclick = closeModal;
        return;
      }
      if (dbfs.length && ks.length) kinds[ks[0]] = kinds[ks[0]].concat(dbfs.filter(function () { return DBF_KINDS[ks[0]]; }));
      dbfs.forEach(function (f) { if (Core.extName(f.name) === 'D14') stashBmD14(f); });
      if (!ks.length) {
        modal('<h3>認不出這個檔案</h3><p>' + esc(unknown.join('、')) + '</p><p>請直接在首頁點選要做的轉換，再放入檔案。</p><div style="text-align:right"><button class="btn primary" id="ok1">好</button></div>');
        $('ok1').onclick = closeModal;
        return;
      }
      var k = ks[0];
      if (ks.length > 1 || unknown.length) toast('一次只能做一種轉換，先處理「' + KINDS[k].title + '」的檔案');
      openKind(k);
      mergeInputs(kinds[k]);
      run();
    });
  }

  // ═════════════ 航照底圖（國土測繪中心 WMTS）＋ 偏差校正 ═════════════

  var bmD14 = null; // 套合用的 D14：{ name, db }
  function stashBmD14(f) {
    try { var db = Core.parseDbf(f.bytes); if (db.fields.some(function (x) { return x.name === 'COT_NUMBER'; })) bmD14 = { name: f.name, db: db }; } catch (e) {}
  }
  function loadBm() { try { return JSON.parse(localStorage.getItem('chsys-bm') || '{}'); } catch (e) { return {}; } }
  function saveBm(o) { try { localStorage.setItem('chsys-bm', JSON.stringify(o)); } catch (e) {} }
  function bmState() {
    if (!state.bm) {
      var m = loadBm();
      state.bm = { src: 'PHOTO2', years: null, margin: m.margin != null ? m.margin : 30, minSize: m.minSize != null ? m.minSize : 200,
        code: m.code != null ? m.code : 87, mode: null, manual: m.manual || {}, clicks: {}, off: {}, incAll: false, out: null, busy: false };
    }
    return state.bm;
  }
  function bmPersist() { var b = bmState(); saveBm({ margin: b.margin, minSize: b.minSize, code: b.code, manual: b.manual }); }
  function bmD14Now() { return (state.dbf && state.dbf.D14 && { name: state.dbf.D14.name, db: state.dbf.D14.db }) || bmD14; }

  /** 本次作業的所有點（含控制點），給套合選點用 */
  function bmAllPoints(r) {
    var pts = [];
    r.parts.forEach(function (p) { pts = pts.concat(plotData(r, p, true).pts.filter(function (q) { return q.cls !== 'off'; })); });
    return pts;
  }
  /** 決定範圍用的點：控制點常分散很遠，有其他點時不算 */
  function bmAreaPoints(r) {
    var pts = bmAllPoints(r), nonCtl = pts.filter(function (q) { return q.cls !== 'ctl'; });
    return nonCtl.length ? nonCtl : pts;
  }
  function bmArea(r) {
    var b = bmState();
    return Core.basemapArea(bmAreaPoints(r).map(function (q) { return { N: q.N, E: q.E, name: q.name }; }), { margin: b.margin, minSize: b.minSize, includeAll: b.incAll });
  }
  /** 套合點：D14 的航照判讀點（自動）＋ 使用者在航照上點的 */
  function bmPairs(src) {
    var b = bmState(), d = bmD14Now(), list = [];
    src = src || b.src;
    if (d && b.code !== '' && b.code != null) Core.suggestImagePairs(d.db, +b.code).forEach(function (x) {
      if (x.real) list.push({ id: 'a:' + x.img.label, auto: true, real: x.real, img: x.img });
    });
    (b.clicks[src] || []).forEach(function (x) { list.push(x); });
    list.forEach(function (x) { x.on = !b.off[x.id]; });
    return list;
  }
  function bmShiftFor(mode, src) {
    var b = bmState();
    src = src || b.src;
    if (mode === 'pairs') {
      var sh = Core.shiftFromPairs(bmPairs(src).filter(function (x) { return x.on; }));
      return sh ? { dN: sh.dN, dE: sh.dE, mode: mode, info: sh } : { dN: 0, dE: 0, mode: mode };
    }
    if (mode === 'manual') { var m = b.manual[src] || {}; return { dN: +m.dN || 0, dE: +m.dE || 0, mode: mode }; }
    return { dN: 0, dE: 0, mode: 'none' };
  }
  function bmShift() {
    var b = bmState();
    return bmShiftFor(b.mode || 'pairs');
  }
  var f3 = function (v) { return (v >= 0 ? '+' : '') + v.toFixed(3); };

  /** 其他轉換的結果頁：一行捷徑，改做航照圖 */
  function renderBmShortcut(r) {
    var sc = $('bmShortcut');
    var show = (r.kind === 'l2csv' || r.kind === 'coa2csv') && bmAllPoints(r).length > 0;
    sc.classList.toggle('hidden', !show);
    if (!show) return;
    $('bmGoKind').onclick = function () {
      var keep = state.inputs.slice(), d14 = bmD14Now();
      openKind('basemap'); state.inputs = keep; if (d14) bmD14 = d14; run();
    };
  }

  function renderBasemapPanel(r) {
    var panel = $('bmPanel'), box = $('bm');
    var isBm = r.kind === 'basemap';
    panel.classList.toggle('hidden', !isBm);
    renderBmShortcut(r);
    if (!isBm) return;
    var b = bmState();
    var area = bmArea(r);
    if (!area) { box.innerHTML = '<div class="blocked">讀不到坐標，請確認放的是 .L14／.L20（或 .L02）。</div>'; return; }
    var sh = bmShift(), pairs = bmPairs(), d14 = bmD14Now();
    var dt = bmDatum(), plan = Core.planBasemap(area.bbox, b.src, sh, null, dt.datum);
    var h = [];

    // ① 範圍
    h.push('<div class="bmsec"><div class="bmnum">1</div><div class="bmbody"><h4>範圍 <span class="muted">（以點位為中心）</span></h4>');
    h.push('<div class="bmgrid">');
    var dtxt = dt.codes.length ? dt.codes.map(function (c) { return secLabel(c) + '（' + (Core.sectionDatum(c) === 'TWD67' ? '67 段' : '97 段') + '）'; }).join('、') : '檔名看不出段號';
    h.push('<label>坐標</label><div class="bmdat"><span class="seg">' + ['', 'TWD97', 'TWD67'].map(function (v) {
      var on = v ? (dt.forced && dt.datum === v) : !dt.forced;
      return '<button type="button" class="bmDt' + (on ? ' on' : '') + '" data-v="' + v + '">' + (v ? v : '自動（' + dt.auto + '）') + '</button>';
    }).join('') + '</span> <span class="muted">' + esc(dtxt) + '</span>' +
      (dt.datum === 'TWD67' ? '<div class="bmnote" style="margin-top:6px">這是 <b>TWD67</b> 的段：航照會自動換算成 67 坐標輸出（JGW 也是 67），可以直接和這個段的資料疊圖。67→97 用近似公式（誤差約 1～2 m），剩下的偏差用下面的套合點校正。</div>' : '') +
      (dt.mixed ? '<div class="warnTxt">⚠ 放進來的檔案有 67 段也有 97 段，請一次只放同一個坐標系統的段，或在上面指定。</div>' : '') + '</div>');
    h.push('<label>中心</label><div>' + area.main.length + ' 個點的中心（N ' + area.center.N.toFixed(1) + '、E ' + area.center.E.toFixed(1) + '）</div>');
    h.push('<label>大小</label><div>' + Math.round(area.size[0]) + ' × ' + Math.round(area.size[1]) + ' m　點位外擴 <input id="bmMargin" type="number" min="0" max="500" step="10" value="' + b.margin + '" style="width:64px"> m，最小 <input id="bmMin" type="number" min="50" max="2000" step="50" value="' + b.minSize + '" style="width:72px"> m</div>');
    h.push('</div>');
    if (area.outliers.length || b.incAll) {
      var od = area.outliers.slice(0, 5).map(function (q) { return esc(q.name) + '（離中心 ' + fmtDist(Math.hypot(q.E - area.center.E, q.N - area.center.N)) + '）'; }).join('、');
      h.push('<div class="bmnote">' + (b.incAll ? '已把所有點都算進範圍。' : '⚠ 有 ' + area.outliers.length + ' 個點離其他點很遠，沒算進範圍，圖才會置中：' + od + (area.outliers.length > 5 ? ' …' : '')) +
        ' <label style="cursor:pointer"><input type="checkbox" id="bmIncAll"' + (b.incAll ? ' checked' : '') + '> 全部算進去</label></div>');
    }
    h.push('</div></div>');

    // ② 圖源：預設最新；可以指定年份（同一張航照的年份併在一起），或用 TWD97 原生的 _3826
    var yr = bmYears(area), S0 = Core.BASEMAP_SOURCES[b.src] || {};
    var isYear = Core.PHOTO_YEARS.indexOf(b.src) >= 0;
    var latestTxt = yr && yr.status === 'done' ? (yr.latestYear ? '這裡最新的是 <b>' + yr.latestYear + ' 年圖層</b>' : '最新的航照') : (yr && yr.status === 'fail' ? '查不到拍攝年份（網路？）' : '查詢拍攝年份中…');
    var yearOpts = yr && yr.status === 'done' ? yr.groups.map(function (g) {
      var t = (g.key === 'PHOTO1' ? '92～94 年' : g.year + ' 年') + '圖層' + (g.years.length > 1 ? '（' + g.years[0] + '～' + g.years[g.years.length - 1] + ' 年都是這張）' : '') + (g.latest ? '＝最新' : '');
      return '<option value="' + g.key + '"' + (g.key === b.src ? ' selected' : '') + '>' + t + '</option>';
    }).join('') : (isYear ? '<option value="' + b.src + '" selected>' + esc(S0.label) + '</option>' : '<option value="">查詢中…</option>');
    h.push('<div class="bmsec"><div class="bmnum">2</div><div class="bmbody"><h4>圖源 <span class="muted">（國土測繪中心，需要網路）</span></h4><div class="bmsrcs">' +
      '<label class="bmsrc' + (b.src === 'PHOTO2' ? ' on' : '') + '"><input type="radio" name="bmSrc" value="PHOTO2"' + (b.src === 'PHOTO2' ? ' checked' : '') + '><b>最新（預設）</b><span>' + latestTxt + '，約 0.14 m／像素</span></label>' +
      '<div class="bmsrc' + (isYear ? ' on' : '') + '" id="bmYearCard"><b>指定年份</b><span>看舊地物、或最新那張被樹擋住時換一張</span><select id="bmYear">' + (isYear ? '' : '<option value="" selected>選年份…</option>') + yearOpts + '</select></div>' +
      '<label class="bmsrc' + (b.src === 'PHOTO3826' ? ' on' : '') + '"><input type="radio" name="bmSrc" value="PHOTO3826"' + (b.src === 'PHOTO3826' ? ' checked' : '') + '><b>通用_3826（TWD97 原生）</b><span>0.26 m／像素，不用轉投影；年份可能比最新舊</span></label>' +
      '</div>' +
      '<div class="muted">輸出 ' + plan.width + ' × ' + plan.height + ' 像素（' + plan.res.toFixed(3) + ' m／像素，' + plan.tiles.length + ' 張圖磚）' +
      (plan.reduced ? '<span class="warnTxt">　範圍較大，已自動降低解析度</span>' : '') + (plan.tooBig ? '<span class="warnTxt">　範圍太大，請縮小</span>' : '') +
      '<br>不同年份的航照偏差可能不一樣，換圖源後要重新選套合點。</div></div></div>');

    // ③ 偏差校正
    var radio = function (v, t) { return '<label class="bmr"><input type="radio" name="bmMode" value="' + v + '"' + (sh.mode === v ? ' checked' : '') + '> ' + t + '</label>'; };
    h.push('<div class="bmsec"><div class="bmnum">3</div><div class="bmbody"><h4>偏差校正 <span class="muted">（把航照移到實測位置）</span></h4>');
    h.push('<div class="bmmodes">' + radio('pairs', '用套合點（建議）') + radio('manual', '直接輸入位移') + radio('none', '不校正') + '</div>');
    if (sh.mode === 'pairs') {
      if (pairs.length) {
        h.push('<table class="bmpairs"><thead><tr><th>用</th><th>實測點</th><th>航照上的位置</th><th>ΔN</th><th>ΔE</th><th>距離</th><th>和平均差</th><th></th></tr></thead><tbody>');
        pairs.forEach(function (x) {
          var dN = x.real.N - x.img.N, dE = x.real.E - x.img.E;
          var resid = x.on && sh.info ? Math.hypot(dN - sh.dN, dE - sh.dE) : null;
          h.push('<tr' + (x.on ? '' : ' class="off"') + '><td><input type="checkbox" class="bmUse" data-id="' + esc(x.id) + '"' + (x.on ? ' checked' : '') + '></td><td>' + esc(x.real.label) + '</td><td>' + (x.auto ? esc(x.img.label) + ' <span class="muted">（D14 判讀點）</span>' : '在航照上點選') + '</td><td>' + f3(dN) + '</td><td>' + f3(dE) + '</td><td>' + Math.hypot(dN, dE).toFixed(2) + ' m</td><td' + (resid > 0.5 ? ' class="warnTxt"' : '') + '>' + (resid == null ? '—' : resid.toFixed(2) + ' m') + '</td><td>' + (x.auto ? '' : '<button class="btn small bmDel" data-id="' + esc(x.id) + '" type="button" title="刪除">✕</button>') + '</td></tr>');
        });
        h.push('</tbody></table><div class="muted">多選幾組、分散在圖的四周最準。「和平均差」超過 0.5 m 的可能點錯，可取消勾選或刪除。</div>');
      } else {
        h.push('<div class="bmhow"><b>怎麼做：</b>先按下面「抓航照底圖」輸出一次 → 按「🎯 選套合點」→ 點一下<b>實測點</b>（例如建物角、圍牆角）→ 再點一下<b>航照上那個點真正的位置</b>。選 2～3 組後按「套用並重新輸出」。</div>');
      }
      h.push('<div class="muted" style="margin-top:6px">D14 的航照判讀點編碼 <input id="bmCode" type="number" min="0" max="99" value="' + esc(b.code) + '" style="width:56px">（D14 裡有這個編碼的點，會自動配對 10 m 內最近的實測點；不用就清空）' +
        (d14 ? '　來源：' + esc(d14.name) : '　<button class="btn small" id="bmPickD14" type="button">選 D14 檔</button>') + '</div>');
    } else if (sh.mode === 'manual') {
      var m = b.manual[b.src] || {};
      h.push('<div>N <input id="bmDN" type="number" step="0.001" value="' + (m.dN != null ? m.dN : '') + '" placeholder="0" style="width:100px"> m　E <input id="bmDE" type="number" step="0.001" value="' + (m.dE != null ? m.dE : '') + '" placeholder="0" style="width:100px"> m　<span class="muted">（實測 − 航照；會記住）</span></div>');
    }
    h.push('<div class="bmshift">套用位移：<b>N ' + f3(sh.dN) + ' m、E ' + f3(sh.dE) + ' m</b>（共 ' + Math.hypot(sh.dN, sh.dE).toFixed(2) + ' m）</div>');
    h.push('</div></div>');

    // ④ 輸出
    h.push('<div class="bmsec"><div class="bmnum">4</div><div class="bmbody"><h4>輸出</h4>');
    h.push('<div class="bmact"><button class="btn go" id="bmGo" type="button"' + (plan.tooBig || b.busy ? ' disabled' : '') + '>' + (b.busy ? '下載中…' : (b.out ? '🛰 重新抓航照底圖' : '🛰 抓航照底圖')) + '</button><span id="bmProg" class="muted"></span></div>');
    if (b.out) {
      var stale = Math.abs(b.out.shift.dN - sh.dN) > 0.0005 || Math.abs(b.out.shift.dE - sh.dE) > 0.0005 || b.out.plan.source !== b.src ||
        Math.abs(b.out.plan.ulE - plan.ulE) > 0.01 || Math.abs(b.out.plan.ulN - plan.ulN) > 0.01 || b.out.plan.width !== plan.width;
      h.push('<div class="bmout"><img id="bmThumb" src="' + b.out.url + '" alt="航照底圖" title="點一下放大、選套合點"><div class="grow"><div><b>' + esc(b.out.files[0].name) + '</b>＋<b>' + esc(b.out.files[1].name) + '</b>　' + b.out.w + ' × ' + b.out.h + '，' + fmtSize(b.out.files[0].content.size) + '</div>' +
        '<div class="muted">' + esc(b.out.note) + '</div>' +
        (stale ? '<div class="warnTxt">設定改過了，請按「重新抓航照底圖」更新。</div>' : '') +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn go" id="bmSave" type="button">⬇ 下載 JPG + JGW</button><button class="btn primary" id="bmPick" type="button">🎯 選套合點</button><button class="btn" id="bmView" type="button">🔍 放大檢查</button></div>' +
        '<div class="bmsavedir" id="bmSaveDir"></div><div class="fstat" data-key="' + esc(b.out.files[0].name) + '"></div></div></div>');
    }
    h.push('</div></div>');
    box.innerHTML = h.join('');

    var rerender = function () { renderBasemapPanel(state.result); };
    Array.prototype.forEach.call(box.querySelectorAll('.bmDt'), function (x) { x.onclick = function () { b.datum = x.getAttribute('data-v') || null; b.out = null; rerender(); }; });
    $('bmMargin').onchange = function () { b.margin = Math.max(0, Math.min(500, +this.value || 0)); bmPersist(); rerender(); };
    $('bmMin').onchange = function () { b.minSize = Math.max(50, Math.min(2000, +this.value || 200)); bmPersist(); rerender(); };
    if ($('bmIncAll')) $('bmIncAll').onchange = function () { b.incAll = this.checked; rerender(); };
    Array.prototype.forEach.call(box.querySelectorAll('input[name=bmSrc]'), function (x) { x.onchange = function () { b.src = x.value; rerender(); }; });
    $('bmYear').onchange = function () { if (this.value) { b.src = this.value; rerender(); } };
    $('bmYearCard').onclick = function (e) {
      if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
      if (isYear) return;
      var o = Array.prototype.filter.call($('bmYear').options, function (x) { return x.value; });
      var pick = o.filter(function (x) { return !/＝最新/.test(x.textContent); })[0] || o[0];
      if (pick) { b.src = pick.value; rerender(); } else $('bmYear').focus();
    };
    Array.prototype.forEach.call(box.querySelectorAll('input[name=bmMode]'), function (x) { x.onchange = function () { b.mode = x.value; rerender(); }; });
    Array.prototype.forEach.call(box.querySelectorAll('.bmUse'), function (x) { x.onchange = function () { b.off[x.getAttribute('data-id')] = !x.checked; rerender(); }; });
    Array.prototype.forEach.call(box.querySelectorAll('.bmDel'), function (x) { x.onclick = function () { bmDelPair(x.getAttribute('data-id')); rerender(); }; });
    if ($('bmCode')) $('bmCode').onchange = function () { b.code = this.value === '' ? '' : Math.max(0, Math.min(99, parseInt(this.value, 10) || 0)); bmPersist(); rerender(); };
    if ($('bmDN')) [$('bmDN'), $('bmDE')].forEach(function (x) {
      x.onchange = function () { var v = $('bmDN').value, w = $('bmDE').value; b.manual[b.src] = { dN: v === '' ? 0 : +v, dE: w === '' ? 0 : +w }; bmPersist(); rerender(); };
    });
    if ($('bmPickD14')) $('bmPickD14').onclick = function () {
      var inp = el('input', { type: 'file', accept: '.D14,.d14' });
      inp.onchange = function () { if (!inp.files[0]) return; readFiles([inp.files[0]]).then(function (l) { stashBmD14(l[0]); if (!bmD14) toast('讀不懂這個 D14'); rerender(); }); };
      inp.click();
    };
    $('bmGo').onclick = function () { makeBasemap(r, area.bbox, sh); };
    if (b.out) {
      $('bmSave').onclick = function () { downloadAll(b.out.files); };
      $('bmSaveDir').appendChild(makeSaveDirBtn());
      $('bmPick').onclick = function () { viewBasemap(r, true); };
      $('bmView').onclick = $('bmThumb').onclick = function () { viewBasemap(r, false); };
    }
  }
  /** 這個案件是 TWD67 還是 TWD97：看檔名的段號（67 段清單同地籍共作平台），也可以手動指定 */
  function bmDatum() {
    var b = bmState(), codes = [];
    state.inputs.forEach(function (f) { var c = Core.sectionCode(inputKey(f)); if (c && codes.indexOf(c) < 0) codes.push(c); });
    var autoD = codes.some(function (c) { return Core.sectionDatum(c) === 'TWD67'; }) ? 'TWD67' : 'TWD97';
    var mixed = codes.length > 1 && codes.some(function (c) { return Core.sectionDatum(c) !== autoD; });
    return { datum: b.datum || autoD, auto: autoD, forced: !!b.datum, codes: codes, mixed: mixed };
  }
  function bmDatumText() { var d = bmDatum(); return (d.codes.length ? d.codes.map(secLabel).join('、') + '，' : '') + d.datum + ' 坐標。'; }
  function secLabel(c) { return c + (Core.SECTION_NAMES[c] ? ' ' + Core.SECTION_NAMES[c] : ''); }
  /**
   * 查各年度在範圍中心是哪一張航照（抓中心那張圖磚比對內容），結果記在 b.years，查完重畫。
   */
  function bmYears(area) {
    var b = bmState(), c = area.center, d = bmDatum();
    var N = c.N, E = c.E;
    if (d.datum === 'TWD67') { var q = Core.twd67to97(N, E); N = q[0]; E = q[1]; }
    var key = Core.probeTileUrl('PHOTO2', N, E);
    if (b.years && b.years.key === key) return b.years;
    var yr = b.years = { key: key, status: 'loading' };
    var layers = ['PHOTO2'].concat(Core.PHOTO_YEARS), probes = {};
    Promise.all(layers.map(function (k) {
      return fetch(Core.probeTileUrl(k, N, E)).then(function (r) { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(function (buf) { return tileHash(buf).then(function (hh) { probes[k] = hh; }); })
        .catch(function () { probes[k] = null; });
    })).then(function () {
      if (b.years !== yr) return;
      if (probes.PHOTO2 == null) { yr.status = 'fail'; }
      else { var g = Core.groupPhotoYears(probes); yr.groups = g.groups; yr.latestYear = g.latestYear; yr.status = 'done'; }
      if (state.result && state.result.kind === 'basemap' && state.bm === b) renderResult();
    });
    return yr;
  }
  /** 圖磚內容指紋；整張同一個顏色（沒有影像）回傳 null */
  function tileHash(buf) {
    var u = new Uint8Array(buf), h1 = 2166136261;
    for (var i = 0; i < u.length; i++) { h1 ^= u[i]; h1 = Math.imul(h1, 16777619); }
    var hash = (h1 >>> 0).toString(16) + ':' + u.length;
    if (u.length > 3000 || !window.createImageBitmap) return Promise.resolve(hash);
    return createImageBitmap(new Blob([u])).then(function (im) {
      var cv = document.createElement('canvas'); cv.width = 16; cv.height = 16;
      var g = cv.getContext('2d'); g.drawImage(im, 0, 0, 16, 16);
      var px = g.getImageData(0, 0, 16, 16).data, mn = 255, mx = 0;
      for (var k = 0; k < px.length; k += 4) { var v = px[k] + px[k + 1] + px[k + 2]; mn = Math.min(mn, v); mx = Math.max(mx, v); }
      return mx - mn < 12 ? null : hash;
    }, function () { return hash; });
  }
  function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m'; }
  function bmDelPair(id) {
    var b = bmState();
    b.clicks[b.src] = (b.clicks[b.src] || []).filter(function (x) { return x.id !== id; });
  }

  /** 依序抓磁磚（同時 6 張），拼成一張圖 */
  function fetchTiles(plan, onProgress) {
    var W = plan.tileCols * 256, H = plan.tileRows * 256;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    var i = 0, done = 0, failed = 0, lastErr = '';
    function next() {
      if (i >= plan.tiles.length) return Promise.resolve();
      var t = plan.tiles[i++];
      return fetch(t.url).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.blob();
      }).then(function (bl) { return createImageBitmap(bl); }).then(function (im) { g.drawImage(im, t.dx, t.dy); if (im.close) im.close(); })
        .catch(function (e) { failed++; lastErr = e.message || String(e); })
        .then(function () { done++; onProgress(done, plan.tiles.length); return next(); });
    }
    var workers = []; for (var k = 0; k < 6; k++) workers.push(next());
    return Promise.all(workers).then(function () { return { canvas: cv, failed: failed, lastErr: lastErr }; });
  }

  function makeBasemap(r, bbox, sh) {
    var b = bmState();
    var dt = bmDatum(), plan = Core.planBasemap(bbox, b.src, sh, null, dt.datum);
    if (plan.tooBig) return;
    b.busy = true; renderBasemapPanel(r);
    var prog = function (d, n) { var e = $('bmProg'); if (e) e.textContent = '下載圖磚 ' + d + ' / ' + n; };
    fetchTiles(plan, prog).then(function (m) {
      if (m.failed === plan.tiles.length) throw new Error('連不上國土測繪中心的圖資服務（' + m.lastErr + '）。請確認電腦有連上網路，或稍後再試。');
      var e = $('bmProg'); if (e) e.textContent = '接圖中…';
      return new Promise(function (ok) { setTimeout(ok, 30); }).then(function () {
        var out = document.createElement('canvas'); out.width = plan.width; out.height = plan.height;
        var og = out.getContext('2d');
        if (plan.kind === 'merc') {
          var src = m.canvas.getContext('2d').getImageData(0, 0, m.canvas.width, m.canvas.height);
          var px = Core.resampleMercToTm2(src.data, src.width, src.height, plan, sh);
          og.putImageData(new ImageData(px, plan.width, plan.height), 0, 0);
        } else {
          og.drawImage(m.canvas, plan.cropX, plan.cropY, plan.width, plan.height, 0, 0, plan.width, plan.height);
        }
        return new Promise(function (ok, bad) { out.toBlob(function (bl) { bl ? ok({ blob: bl, failed: m.failed }) : bad(new Error('影像太大，瀏覽器無法存成 JPG，請縮小範圍')); }, 'image/jpeg', 0.9); });
      });
    }).then(function (x) {
      var base = bmBaseName();
      var yy = b.years && b.years.status === 'done' ? b.years : null;
      var srcName = b.src === 'PHOTO2' ? '最新正射影像' + (yy && yy.latestYear ? '（' + yy.latestYear + ' 年圖層）' : '') : b.src === 'PHOTO3826' ? '正射影像圖(通用)_3826' : Core.BASEMAP_SOURCES[b.src].label;
      var note = srcName + '，' + dt.datum + ' 坐標，' + plan.res.toFixed(3) + ' m／像素；' +
        (sh.mode === 'none' || (!sh.dN && !sh.dE) ? '未校正偏差' : '已校正 N ' + f3(sh.dN) + '、E ' + f3(sh.dE) + ' m') +
        (x.failed ? '；有 ' + x.failed + ' 張圖磚沒抓到（白色區塊）' : '');
      if (b.out && b.out.url) URL.revokeObjectURL(b.out.url);
      b.out = { url: URL.createObjectURL(x.blob), w: plan.width, h: plan.height, plan: plan, shift: { dN: sh.dN, dE: sh.dE }, note: note,
        files: [{ name: base + '_航照' + (dt.datum === 'TWD67' ? '_TWD67' : '') + '.jpg', content: x.blob }, { name: base + '_航照' + (dt.datum === 'TWD67' ? '_TWD67' : '') + '.jgw', content: Core.worldFileText(plan.res, plan.ulE, plan.ulN) }] };
      b.busy = false; renderBasemapPanel(r); setSteps(3);
      toast('航照底圖好了！可以先「選套合點」校正，或直接下載');
    }).catch(function (e) {
      b.busy = false; renderBasemapPanel(r);
      modal('<h3>❌ 航照底圖沒有抓成功</h3><p>' + esc(e.message || e) + '</p><div style="text-align:right;margin-top:12px"><button class="btn primary" id="bmErrOk">知道了</button></div>');
      $('bmErrOk').onclick = closeModal;
    });
  }

  function bmBaseName() {
    var n = (state.opts.outName || (state.inputs[0] && state.inputs[0].name) || '航照').replace(/\.[^.]*$/, '');
    return n || '航照';
  }

  /**
   * 放大檢查／選套合點：滾輪縮放、拖曳移動。
   * 選點：① 點實測點（黃＝本次點位、灰＝D14 參考點）② 點航照上它真正的位置。
   * 已選的套合點會即時預覽校正後的樣子（影像跟著移動）。
   */
  function viewBasemap(r, pickMode) {
    var b = bmState(), o = b.out; if (!o) return;
    var pl = o.plan;
    var toPx = function (E, N) { return [(E - pl.ulE) / pl.res + 0.5, (pl.ulN - N) / pl.res + 0.5]; };
    var toEN = function (x, y) { return { E: pl.ulE + (x - 0.5) * pl.res, N: pl.ulN - (y - 0.5) * pl.res }; };
    var inside = function (q) { var p = toPx(q.E, q.N); return p[0] >= -20 && p[1] >= -20 && p[0] <= o.w + 20 && p[1] <= o.h + 20; };
    // 候選實測點：本次點位＋D14 參考點（編碼 00 以外、在圖內）
    var cands = bmAllPoints(r).filter(inside).map(function (q) { return { E: q.E, N: q.N, label: q.name, job: true }; });
    var seen = {}; cands.forEach(function (q) { seen[Math.round(q.E * 100) + ',' + Math.round(q.N * 100)] = 1; });
    var d14 = bmD14Now();
    if (d14) d14.db.records.forEach(function (rec) {
      if (rec.deleted) return;
      var q = { E: parseFloat(rec.values.COT_X), N: parseFloat(rec.values.COT_Y) };
      var ref = parseInt(rec.values.COT_REF, 10) || 0;
      q.label = parseInt(rec.values.COT_NUMBER, 10) + '.' + (ref < 10 ? '0' : '') + ref;
      if (!isFinite(q.E) || !isFinite(q.N) || !inside(q) || String(ref) === String(b.code)) return;
      var k = Math.round(q.E * 100) + ',' + Math.round(q.N * 100);
      if (!seen[k]) { seen[k] = 1; cands.push(q); }
    });
    var V = { z: 1, tx: 0, ty: 0, step: pickMode ? 1 : 0, sel: null, preview: true };

    modal('<div class="bmvhead"><h3>' + (pickMode ? '🎯 選套合點' : '🔍 放大檢查') + ' <span class="muted">' + esc(o.note) + '</span></h3></div>' +
      '<div class="bmguide" id="bmGuide"></div>' +
      '<div class="bmview" id="bmViewer"><div class="bmin" id="bmIn"><img src="' + o.url + '" id="bmImg" draggable="false"><canvas id="bmYearCv" class="ylayer hidden"></canvas><svg id="bmSvg" xmlns="http://www.w3.org/2000/svg"></svg></div>' +
      '<div class="bmzoom"><button type="button" id="bmZin" title="放大">＋</button><button type="button" id="bmZout" title="縮小">－</button><button type="button" id="bmZfit" title="看全圖">⤢</button></div><div class="yload hidden" id="bmYLoad"></div></div>' +
      '<div class="ybar" id="bmYBar"></div>' +
      '<div class="bmvfoot"><div class="legend"><span><i style="background:#ffd400"></i>本次點位</span>' + (d14 ? '<span><i style="background:#d0d7de"></i>D14 參考點</span>' : '') + '<span><i style="border:2px solid #ff3b30"></i>套合：實測</span><span><i style="border:2px solid #19c3ff"></i>套合：航照位置</span></div>' +
      '<label class="muted" style="cursor:pointer"><input type="checkbox" id="bmPrev" checked> 預覽校正後的樣子</label></div>' +
      '<div id="bmVPairs" class="bmvpairs"></div>' +
      '<div class="bmvbtns"><button class="btn primary" id="bmAdd" type="button">➕ 新增套合點</button><span class="grow"></span><button class="btn" id="bmClose" type="button">關閉</button><button class="btn go" id="bmApply" type="button">✓ 套用並重新輸出</button></div>', true);

    var view = $('bmViewer'), inner = $('bmIn'), img = $('bmImg'), svg = $('bmSvg');
    inner.style.width = o.w + 'px'; inner.style.height = o.h + 'px';
    svg.setAttribute('width', o.w); svg.setAttribute('height', o.h); svg.setAttribute('viewBox', '0 0 ' + o.w + ' ' + o.h);
    var fitZ = function () { return Math.min(view.clientWidth / o.w, view.clientHeight / o.h); };
    var apply = function () { inner.style.transform = 'translate(' + V.tx + 'px,' + V.ty + 'px) scale(' + V.z + ')'; draw(); };
    var fit = function () { V.z = fitZ(); V.tx = (view.clientWidth - o.w * V.z) / 2; V.ty = (view.clientHeight - o.h * V.z) / 2; apply(); };
    var zoomAt = function (f, cx, cy) {
      var nz = Math.max(fitZ() * 0.5, Math.min(8, V.z * f));
      V.tx = cx - (cx - V.tx) * nz / V.z; V.ty = cy - (cy - V.ty) * nz / V.z; V.z = nz; apply();
    };
    // 目前畫面上影像的總位移（輸出時已套用的 ＋ 預覽中新增的）
    var dispShift = function () {
      if (!V.preview) return o.shift;
      var s = bmShiftFor('pairs');
      return (s.info ? s : o.shift);
    };
    var draw = function () {
      var ds = dispShift(), dx = (ds.dE - o.shift.dE) / pl.res, dy = -(ds.dN - o.shift.dN) / pl.res;
      img.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      var k = 1 / V.z, out = [];
      cands.forEach(function (q) {
        var p = toPx(q.E, q.N), on = V.sel === q;
        out.push('<circle cx="' + p[0].toFixed(2) + '" cy="' + p[1].toFixed(2) + '" r="' + ((on ? 7 : q.job ? 4 : 3) * k).toFixed(3) + '" fill="' + (on ? '#ff3b30' : q.job ? '#ffd400' : '#d0d7de') + '" stroke="#000" stroke-width="' + (0.8 * k).toFixed(3) + '"><title>' + esc(q.label) + '</title></circle>');
        if (V.z > 1.2 || on) out.push('<text x="' + (p[0] + 6 * k).toFixed(2) + '" y="' + (p[1] - 6 * k).toFixed(2) + '" font-size="' + (12 * k).toFixed(3) + '" fill="#fff" stroke="#000" stroke-width="' + (2.5 * k).toFixed(3) + '" paint-order="stroke" pointer-events="none">' + esc(q.label) + '</text>');
      });
      bmPairs().forEach(function (x) {
        var a = toPx(x.real.E, x.real.N);
        var ip = { E: x.img.E + ds.dE, N: x.img.N + ds.dN }, c = toPx(ip.E, ip.N); // 航照上那一點在目前畫面的位置
        var op = x.on ? 1 : 0.35;
        out.push('<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + c[0] + '" y2="' + c[1] + '" stroke="#fff" stroke-width="' + (1.2 * k) + '" opacity="' + op + '"/>');
        out.push('<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + (6 * k) + '" fill="none" stroke="#19c3ff" stroke-width="' + (2 * k) + '" opacity="' + op + '"/>');
        out.push('<circle cx="' + a[0] + '" cy="' + a[1] + '" r="' + (8 * k) + '" fill="none" stroke="#ff3b30" stroke-width="' + (2 * k) + '" opacity="' + op + '"><title>' + esc(x.real.label) + '</title></circle>');
      });
      svg.innerHTML = out.join('');
    };
    var guide = function () {
      var g = $('bmGuide'), n = bmPairs().filter(function (x) { return x.on; }).length;
      view.classList.toggle('picking', V.step > 0);
      if (V.step === 1) g.innerHTML = '<b>① 點一下「實測點」</b>（黃點／灰點）。選建物角、圍牆角這種在航照上看得清楚的點。<span class="muted">滾輪放大、拖曳移動</span> <button class="btn small" id="bmCancel" type="button">取消</button>';
      else if (V.step === 2) g.innerHTML = '<b>② 在航照上點一下「' + esc(V.sel.label) + '」真正的位置</b>（放大點準一點）。 <button class="btn small" id="bmCancel" type="button">取消</button>';
      else if (Y.shown !== Y.base) g.innerHTML = '正在看 <b>' + esc((Y.groups[Y.shown] || {}).label || '') + '</b> 的航照（點位不動，只換影像）。實際拍攝年份看影像上的浮水印（例「nlsc.gov.tw 2016」）。要用這一張就按「用這一年輸出」。';
      else g.innerHTML = n ? '已選 <b>' + n + '</b> 組套合點' + (n < 2 ? '，建議再選 1～2 組（分散在圖的不同位置）' : '') + '。確認地物對齊紅圈後，按右下角「套用並重新輸出」。' : '按「➕ 新增套合點」開始。也可以只看：滾輪放大、拖曳移動。';
      g.className = 'bmguide' + (V.step ? ' active' : '');
      if ($('bmCancel')) $('bmCancel').onclick = function () { V.step = 0; V.sel = null; guide(); draw(); };
      var pv = $('bmVPairs'), sh = bmShiftFor('pairs');
      pv.innerHTML = bmPairs().map(function (x) {
        var dN = x.real.N - x.img.N, dE = x.real.E - x.img.E;
        return '<span class="pchip' + (x.on ? '' : ' off') + '">' + esc(x.real.label) + '　ΔN ' + f3(dN) + '　ΔE ' + f3(dE) + (x.auto ? ' <span class="muted">D14</span>' : ' <button type="button" data-id="' + esc(x.id) + '" title="刪除">✕</button>') + '</span>';
      }).join('') + (sh.info ? '<span class="pavg">平均位移 N ' + f3(sh.dN) + '、E ' + f3(sh.dE) + (sh.info.n > 1 ? '，最大差 ' + sh.info.maxResidual.toFixed(2) + ' m' : '') + '</span>' : '');
      Array.prototype.forEach.call(pv.querySelectorAll('button[data-id]'), function (x) { x.onclick = function () { bmDelPair(x.getAttribute('data-id')); guide(); draw(); }; });
      $('bmApply').disabled = !sh.info;
    };
    var onPick = function (x, y) {
      if (Y.shown !== Y.base) { toast('現在顯示的是別的年份；要用這一年選套合點，請先按「用這一年輸出」'); return; }
      if (V.step === 1) {
        var best = null;
        cands.forEach(function (q) { var p = toPx(q.E, q.N), d = Math.hypot(p[0] - x, p[1] - y) * V.z; if (d < 16 && (!best || d < best.d)) best = { q: q, d: d }; });
        if (!best) { toast('請點在黃點或灰點上（可以先放大）'); return; }
        V.sel = best.q; V.step = 2;
      } else if (V.step === 2) {
        var ds = dispShift(), g = toEN(x, y);
        var arr = b.clicks[b.src] = b.clicks[b.src] || [];
        // 同一個實測點再選一次＝更新
        var id = 'c:' + V.sel.label;
        b.clicks[b.src] = arr.filter(function (p) { return p.id !== id; });
        b.clicks[b.src].push({ id: id, real: { E: V.sel.E, N: V.sel.N, label: V.sel.label }, img: { E: g.E - ds.dE, N: g.N - ds.dN, label: '航照' } });
        b.mode = 'pairs'; V.step = 0; V.sel = null;
      }
      guide(); draw();
    };

    // 滑鼠：滾輪縮放、拖曳移動、點一下選點
    var drag = null;
    view.addEventListener('wheel', function (e) { e.preventDefault(); var rc = view.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - rc.left, e.clientY - rc.top); }, { passive: false });
    view.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty, moved: false }; view.setPointerCapture(e.pointerId); });
    view.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true; V.tx = drag.tx + dx; V.ty = drag.ty + dy; inner.style.transform = 'translate(' + V.tx + 'px,' + V.ty + 'px) scale(' + V.z + ')';
    });
    view.addEventListener('pointerup', function (e) {
      var d = drag; drag = null;
      if (!d || d.moved || !V.step) return;
      var rc = view.getBoundingClientRect();
      onPick((e.clientX - rc.left - V.tx) / V.z, (e.clientY - rc.top - V.ty) / V.z);
    });
    $('bmZin').onclick = function () { zoomAt(1.5, view.clientWidth / 2, view.clientHeight / 2); };
    $('bmZout').onclick = function () { zoomAt(1 / 1.5, view.clientWidth / 2, view.clientHeight / 2); };
    $('bmZfit').onclick = fit;
    $('bmPrev').onchange = function () { V.preview = this.checked; draw(); };
    $('bmAdd').onclick = function () {
      if (Y.shown !== Y.base) { toast('請先切回輸出的那一年，或按「用這一年輸出」'); return; }
      V.step = 1; V.sel = null; guide(); draw();
    };
    $('bmClose').onclick = function () { closeModal(); renderBasemapPanel(state.result); };

    // ── 年份軸：拖拉切換各年度航照（先低解析度預覽，停下來再補高解析度） ──
    var Y = { base: -1, shown: -1, groups: [], token: 0, timer: null };
    var ext = { minE: pl.ulE - pl.res / 2, maxN: pl.ulN + pl.res / 2 };
    ext.maxE = ext.minE + o.w * pl.res; ext.minN = ext.maxN - o.h * pl.res;
    var cache = b.yearCache && b.yearCache.url === o.url ? b.yearCache : (b.yearCache = { url: o.url, lo: {}, hi: {}, hiOrder: [] });
    var layer = $('bmYearCv');
    var renderSrc = function (key, zoom) {
      var mode = b.mode || 'pairs', sh = bmShiftFor(mode, key);
      var p2 = Core.planBasemap(ext, key, sh, null, pl.datum, zoom);
      return fetchTiles(p2, function () {}).then(function (m) {
        if (m.failed === p2.tiles.length) throw new Error('連不上國土測繪中心');
        var cv = document.createElement('canvas'); cv.width = p2.width; cv.height = p2.height;
        var src = m.canvas.getContext('2d').getImageData(0, 0, m.canvas.width, m.canvas.height);
        cv.getContext('2d').putImageData(new ImageData(Core.resampleMercToTm2(src.data, src.width, src.height, p2, sh), p2.width, p2.height), 0, 0);
        return { canvas: cv, plan: p2 };
      });
    };
    var paint = function (it) {
      var g = layer.getContext('2d');
      layer.width = it.canvas.width; layer.height = it.canvas.height;
      g.drawImage(it.canvas, 0, 0);
      // 和輸出影像同一個範圍：左上角對齊，寬高換算成輸出影像的像素
      layer.style.left = ((it.plan.ulE - it.plan.res / 2 - ext.minE) / pl.res) + 'px';
      layer.style.top = ((ext.maxN - (it.plan.ulN + it.plan.res / 2)) / pl.res) + 'px';
      layer.style.width = (it.plan.width * it.plan.res / pl.res) + 'px';
      layer.style.height = (it.plan.height * it.plan.res / pl.res) + 'px';
    };
    var loadMsg = function (t) { var e = $('bmYLoad'); if (!e) return; e.textContent = t || ''; e.classList.toggle('hidden', !t); };
    var showYear = function (i) {
      if (i < 0 || i >= Y.groups.length) return;
      Y.shown = i; clearTimeout(Y.timer); var tok = ++Y.token;
      barUi();
      if (i === Y.base) { layer.classList.add('hidden'); img.style.visibility = ''; loadMsg(''); guide(); return; }
      var key = Y.groups[i].key;
      var show = function (it) { if (tok !== Y.token) return; paint(it); layer.classList.remove('hidden'); img.style.visibility = 'hidden'; };
      var hiReady = cache.hi[key];
      if (hiReady) { show(hiReady); loadMsg(''); guide(); return; }
      (cache.lo[key] ? Promise.resolve(cache.lo[key]) : (loadMsg('載入 ' + Y.groups[i].label + ' …'), renderSrc(key, 18).then(function (it) { cache.lo[key] = it; return it; })))
        .then(function (it) {
          show(it); if (tok !== Y.token) return;
          loadMsg('');
          // 停在這一年 0.7 秒 → 補抓高解析度
          Y.timer = setTimeout(function () {
            if (tok !== Y.token) return;
            loadMsg('載入清楚的版本…');
            renderSrc(key, null).then(function (hi) {
              cache.hi[key] = hi; cache.hiOrder.push(key);
              while (cache.hiOrder.length > 3) delete cache.hi[cache.hiOrder.shift()];
              if (tok === Y.token) { show(hi); loadMsg(''); }
            }, function () { if (tok === Y.token) loadMsg(''); });
          }, 700);
        }, function (e) { if (tok === Y.token) loadMsg('載入失敗：' + (e.message || e)); });
      guide();
    };
    var barUi = function () {
      var bar = $('bmYBar'); if (!bar || !Y.groups.length) return;
      var n = Y.groups.length, g = Y.groups[Y.shown] || {};
      $('bmYRange').value = Y.shown;
      Array.prototype.forEach.call(bar.querySelectorAll('.ytick'), function (t, k) { t.classList.toggle('on', k === Y.shown); t.classList.toggle('base', k === Y.base); });
      $('bmYNow').innerHTML = '顯示：<b>' + esc(g.label || '') + '</b>' + (g.span ? '<span class="muted">（' + esc(g.span) + '）</span>' : '') +
        (Y.shown === Y.base ? ' <span class="ybadge">輸出的這張</span>' : '');
      $('bmYUse').disabled = Y.shown === Y.base;
    };
    var buildBar = function () {
      var yr = b.years, bar = $('bmYBar'); if (!bar) return;
      if (!yr || yr.status !== 'done' || !yr.groups.length) { bar.innerHTML = '<div class="muted">' + (yr && yr.status === 'fail' ? '查不到各年度航照' : '查詢各年度航照中…') + '</div>'; return; }
      var gs = yr.groups.slice().reverse().map(function (g) {
        var label = g.key === 'PHOTO1' ? '92～94 年' : g.year + ' 年';
        return { key: g.key, latest: g.latest, label: label + '圖層' + (g.latest ? '（最新）' : ''), tick: g.key === 'PHOTO1' ? '92' : String(g.year),
          span: g.years.length > 1 ? g.years[0] + '～' + g.years[g.years.length - 1] + ' 年都是這張' : '' };
      });
      Y.groups = gs;
      var src = pl.source;
      Y.base = gs.findIndex(function (g) { return src === 'PHOTO2' ? g.latest : g.key === src; });
      if (src === 'PHOTO3826') {
        // _3826 不在年份軸上：多一格放在最右邊
        gs.push({ key: 'PHOTO3826', label: '通用_3826', tick: '3826', span: 'TWD97 原生' });
        Y.base = gs.length - 1;
      }
      var n = gs.length;
      bar.innerHTML = '<div class="yhead"><span class="ytitle">🕰 各年度航照</span><span id="bmYNow"></span><span class="grow"></span>' +
        '<button class="btn small" id="bmYPrev" type="button" title="上一年（←）">◀</button><button class="btn small" id="bmYNext" type="button" title="下一年（→）">▶</button>' +
        '<button class="btn small primary" id="bmYUse" type="button">用這一年輸出</button></div>' +
        '<div class="ytrack"><input type="range" id="bmYRange" min="0" max="' + (n - 1) + '" step="1" value="' + Y.base + '">' +
        '<div class="yticks">' + gs.map(function (g, k) { return '<button type="button" class="ytick" data-i="' + k + '" style="left:' + (n > 1 ? k / (n - 1) * 100 : 50) + '%">' + esc(g.tick) + '</button>'; }).join('') + '</div></div>';
      Y.shown = Y.base;
      $('bmYRange').oninput = function () { showYear(+this.value); };
      Array.prototype.forEach.call(bar.querySelectorAll('.ytick'), function (t) { t.onclick = function () { showYear(+t.getAttribute('data-i')); }; });
      $('bmYPrev').onclick = function () { showYear(Math.max(0, Y.shown - 1)); };
      $('bmYNext').onclick = function () { showYear(Math.min(n - 1, Y.shown + 1)); };
      $('bmYUse').onclick = function () {
        var g = Y.groups[Y.shown]; if (!g) return;
        b.src = g.latest ? 'PHOTO2' : g.key; closeModal();
        var area = bmArea(state.result);
        makeBasemap(state.result, area.bbox, bmShift());
      };
      barUi();
    };
    var keyNav = function (e) {
      if ($('modal').classList.contains('hidden') || !$('bmYBar')) { document.removeEventListener('keydown', keyNav); return; }
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName) && e.target.id !== 'bmYRange') return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); showYear(Math.max(0, Math.min(Y.groups.length - 1, Y.shown + (e.key === 'ArrowLeft' ? -1 : 1)))); }
    };
    document.addEventListener('keydown', keyNav);
    buildBar();
    if (!b.years || b.years.status === 'loading') {
      var waitN = 0, wait = setInterval(function () {
        if (!$('bmYBar') || ++waitN > 60) { clearInterval(wait); return; }
        if (b.years && b.years.status !== 'loading') { clearInterval(wait); buildBar(); }
      }, 500);
    }
    $('bmApply').onclick = function () {
      b.mode = 'pairs'; closeModal();
      var area = bmArea(state.result);
      makeBasemap(state.result, area.bbox, bmShift());
    };
    fit(); guide();
  }

  // ═════════════ 版本、更新歷程、新版本提醒 ═════════════

  var INFO = window.APP_INFO || { version: '0.0.0', changelog: [] };
  var RAW_BASE = 'https://raw.githubusercontent.com/' + INFO.repo + '/HEAD/';

  /** 比較版本號：a > b 回傳正數 */
  function cmpVer(a, b) {
    var x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (var i = 0; i < Math.max(x.length, y.length); i++) {
      var d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function changelogHtml(list, current) {
    return '<div class="changelog">' + list.map(function (c) {
      return '<h4>v' + esc(c.version) + (c.version === current ? '<span class="cur">目前版本</span>' : '') +
        '<span class="muted">' + esc(c.date || '') + '</span></h4><ul>' +
        c.items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
    }).join('') + '</div>';
  }

  function showChangelog() {
    modal('<h3>' + esc(INFO.name || '') + ' v' + esc(INFO.version) + '</h3>' +
      '<div class="muted">發布日期 ' + esc(INFO.date || '') + '</div>' + changelogHtml(INFO.changelog || [], INFO.version) +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
      '<button class="btn" id="chkNow">檢查有沒有新版本</button><button class="btn primary" id="closeLog">關閉</button></div>');
    $('closeLog').onclick = closeModal;
    $('chkNow').onclick = function () { checkUpdate(true); };
  }
  $('btnVersion').textContent = 'v' + INFO.version;
  $('btnVersion').onclick = showChangelog;

  function fetchWithTimeout(url, ms) {
    var ctl = window.AbortController ? new AbortController() : null;
    var t = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
    return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r;
    });
  }

  function checkUpdate(manual) {
    if (!INFO.repo || !window.fetch) return;
    fetchWithTimeout(RAW_BASE + 'version.json?t=' + Date.now(), 8000).then(function (r) { return r.json(); }).then(function (remote) {
      if (cmpVer(remote.version, INFO.version) > 0) {
        var skipped = null;
        try { skipped = localStorage.getItem('chsys-skip-version'); } catch (e) {}
        if (manual || skipped !== remote.version) showUpdate(remote);
        if (manual) closeModal();
      } else if (manual) {
        toast('已經是最新版本 v' + INFO.version);
      }
    }).catch(function () {
      if (manual) toast('無法連線到 GitHub 檢查更新（沒有網路也能正常使用）');
    });
  }

  function showUpdate(remote) {
    var newer = (remote.changelog || []).filter(function (c) { return cmpVer(c.version, INFO.version) > 0; });
    var first = newer.length ? newer[0].items[0] : '';
    var bar = $('updateBar');
    bar.innerHTML = '<div class="wrap"><span class="ut">🔔 有新版本 v' + esc(remote.version) + '</span>' +
      '<span class="grow">目前是 v' + esc(INFO.version) + (first ? '。新內容：' + esc(first) + (newer.length > 1 || newer[0].items.length > 1 ? '…' : '') : '') + '</span>' +
      '<button class="btn small" id="upWhat">看更新內容</button>' +
      '<button class="btn small primary" id="upGet">⬇ 下載新版</button>' +
      '<button class="btn small" id="upSkip">這版先不要</button></div>';
    bar.classList.remove('hidden');
    $('upWhat').onclick = function () {
      modal('<h3>v' + esc(remote.version) + ' 更新了什麼</h3>' + changelogHtml(newer, null) +
        '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px"><button class="btn" id="cl2">關閉</button><button class="btn primary" id="get2">⬇ 下載新版</button></div>');
      $('cl2').onclick = closeModal;
      $('get2').onclick = function () { closeModal(); downloadUpdate(remote); };
    };
    $('upGet').onclick = function () { downloadUpdate(remote); };
    $('upSkip').onclick = function () {
      try { localStorage.setItem('chsys-skip-version', remote.version); } catch (e) {}
      bar.classList.add('hidden');
    };
  }

  function downloadUpdate(remote) {
    var file = remote.file || INFO.file;
    var name = file.replace(/^.*\//, '');
    var page = 'https://github.com/' + INFO.repo + '/blob/HEAD/' + file.split('/').map(encodeURIComponent).join('/');
    toast('下載中…');
    fetchWithTimeout(RAW_BASE + file.split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now(), 30000)
      .then(function (r) { return r.text(); })
      .then(function (html) {
        download({ name: name, content: html }, true, true);
        modal('<h3>新版 v' + esc(remote.version) + ' 已下載</h3>' +
          '<ol class="next"><li><div>到瀏覽器的「下載」資料夾找到 <b>' + esc(name) + '</b>。</div></li>' +
          '<li><div>用它<b>取代</b>你原本放的舊檔（或直接改用新檔）。</div></li>' +
          '<li><div>關掉這個頁面，打開新檔就是新版了。</div></li></ol>' +
          '<div style="text-align:right;margin-top:14px"><button class="btn primary" id="okUp">知道了</button></div>');
        $('okUp').onclick = closeModal;
      })
      .catch(function () {
        modal('<h3>自動下載失敗</h3><p>請到 GitHub 頁面手動下載新版：</p><p><a href="' + esc(page) + '" target="_blank" rel="noopener">' + esc(page) + '</a></p>' +
          '<p class="muted">進去後按右上角的「⬇ Download raw file」。</p><div style="text-align:right"><button class="btn primary" id="okUp2">好</button></div>');
        $('okUp2').onclick = closeModal;
      });
  }

  // 開啟後稍等再檢查，不影響使用；沒有網路就安靜略過
  setTimeout(function () { checkUpdate(false); }, 1500);

  // ─────────── 首頁卡片 ───────────
  Array.prototype.forEach.call(document.querySelectorAll('.card[data-kind]'), function (c) {
    c.onclick = function () { var k = c.getAttribute('data-kind'); if (k === 'coa2csv') state.coaEnabled = true; openKind(k); };
  });
  $('btnBack').onclick = showHome;
  // 角落按鈕：手動啟用複丈輸入檔轉換（資料夾有 L02/L14/L20 時預設不會列出）

})();
