/* 站群使用事件回传 evsite_core.js（M1，正本在 tools/app/；与 sync_core/evlog_core 同块注入）。
   ----------------------------------------------------------------------------
   window.KyEvSite：把「页面进出」按经纪中心平台契约（spec-platform-v3 §六）送进统一账本。
     行： {ts:"2026-08-09T21:00:03.123-04:00", dev:"site", app:"<站名>",
           event:"open"|"close", id:"<yyyyMMddHHmmssSSS 北京>-<rand4>", meta:{…}}
     件： PUT /repos/<repo>/contents/ev/site/<yyyyMMdd 北京>/<HHmmssSSS 北京>-<rand4>.jsonl
          （一次 flush 一文件多行；base64 Contents API；create-only 免 sha，重名换名重试一次）
   进出口径：可见即 open、隐藏/离页即 close（页面进出的浏览器等价物）；页内视图/操作一律
     入 meta，不另发事件、不进配对（契约原文：页内细粒度放 meta，不进配对）。
   信道：与 ky-sync 同信任级——浏览器 fetch 出网，物理过用户 Clash TUN/系统代理，页面 JS
     无绕行面；无 token / 无网 / 接口错 = 静默跳过（fail-closed），本地行为分毫不变。
     铁律 8 复核在案（1ccuse CLAUDE.md）。
   ★ 只在 http(s) 页面动作：file:// 壁纸/本地壳一律零监听零写入零出网（那不是「站」，
     PC 侧另有 ActivityWatch 与执灯流水在账）。
   ★ 未 init / blocked()（selftest/SIM/SEEDED/MEMONLY/coop-join）：整对象零副作用——
     无定时器 / 无监听 / 无网络 / 无 localStorage 写入。
   ★ token 绝不入仓：只从本机 localStorage 取（三源，见 loadCfg）。
   ============================================================================ */
window.KyEvSite = (function () {
  "use strict";
  var API = "https://api.github.com";
  var DEF_REPO = "TricGrizen/agent-center";
  var CFG_KEY = "ky_ev_cfg";      /* 本站自有配置 {tok,repo,on} */
  var PAT_KEY = "jjzx_pat";       /* 经纪中心页同域 PAT（tricgrizen.com 上贴一处、各站通用） */
  var SYNC_KEY = "ky_sync_cfg";   /* 只借其 dev 设备名，不碰 token */
  var QKEY = "ky_evsite_q";       /* 离线队列（同源各站共用；每条自带 app，互不串账） */
  var QCAP = 2000;                /* 队列上限，溢出丢最旧 */
  var MAXAGE = 48 * 3600 * 1000;  /* 超 48h 的陈事件丢弃（账本已翻页，补传无意义） */
  var BATCH = 120;                /* 单文件行数上限（keepalive 体积 64KB 限内） */
  var BJ = 8 * 3600 * 1000;       /* 北京 = UTC+8 固定（1991 起无夏令时，不依赖 Intl） */
  var BACKOFF = [30000, 120000, 600000];

  var APP = null, BLK = null, INIT = false, cfg = null;
  var Q = [], seg = null, busy = false, tmr = 0, failN = 0, coldT = 0;

  /* ---------------- 小工具 ---------------- */
  function p2(n) { return (n < 10 ? "0" : "") + n; }
  function p3(n) { return (n < 10 ? "00" : n < 100 ? "0" : "") + n; }
  function nk(o) { var k; for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) return true; return false; }
  function rnd() { return ("000" + Math.floor(Math.random() * 1679616).toString(36)).slice(-4); }
  function b64e(s) { return btoa(unescape(encodeURIComponent(s))); }
  function blocked() { try { return BLK ? !!BLK() : false; } catch (e) { return true; } }
  function webPage() {
    try { return location.protocol === "https:" || location.protocol === "http:"; } catch (e) { return false; }
  }

  /* ts：设备本地墙上时间 + 真实偏移（契约「ISO 带偏移」；汇流层按偏移换算北京） */
  function isoTs(t) {
    var d = new Date(t), o = -d.getTimezoneOffset(), s = o < 0 ? "-" : "+", a = Math.abs(o);
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + "T" +
      p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()) + "." + p3(d.getMilliseconds()) +
      s + p2(Math.floor(a / 60)) + ":" + p2(a % 60);
  }
  /* 目录与文件名一律北京时（平台 watchDirs 按北京日历日巡目录，须对齐） */
  function bj(t) {
    var d = new Date(t + BJ);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
             H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds(), ms: d.getUTCMilliseconds() };
  }
  function bjYmd(t) { var p = bj(t); return "" + p.y + p2(p.m) + p2(p.d); }
  function bjHms(t) { var p = bj(t); return p2(p.H) + p2(p.M) + p2(p.S) + p3(p.ms); }
  function newId(t) { return bjYmd(t) + bjHms(t) + "-" + rnd(); }

  /* ---------------- 配置（三源；一律本机，绝不入仓） ---------------- */
  function loadCfg() {
    var c = null, v;
    try { c = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch (e) { c = null; }
    if (!c || typeof c !== "object" || !c.tok) c = null;
    if (!c) {                                   /* 同域回落：经纪中心页贴的 PAT（一处贴、各站通用） */
      try { v = localStorage.getItem(PAT_KEY); } catch (e) { v = null; }
      if (v && String(v).trim()) c = { tok: String(v).trim(), repo: DEF_REPO, on: true };
    }
    if (!c) {                                   /* 本机免键盘桩（壁纸/WE 同 sync_cfg.js 先例） */
      try { v = window.__KY_EV_CFG; } catch (e) { v = null; }
      if (v && typeof v === "object" && v.tok)
        c = { tok: String(v.tok).trim(), repo: (v.repo ? String(v.repo).trim() : "") || DEF_REPO, on: v.on !== false };
    }
    if (c && !c.repo) c.repo = DEF_REPO;
    cfg = c; return c;
  }
  function enabled() { return !!(cfg && cfg.on !== false && cfg.tok && cfg.repo); }
  function saveCfg(c) { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} cfg = c; }
  /* 深链一次性配 token：?evtok=…（各 PWA 容器 localStorage 各自独立，装机后每壳开一次即可）；
     取到即从地址栏抹去，且保 history.state 不失（math/vocab 的层栈以 state 为身） */
  function takeTok() {
    try {
      var m = /[?&]evtok=([^&#]+)/.exec(location.search);
      if (!m) return;
      var tok = decodeURIComponent(m[1]).trim();
      var r = /[?&]evrepo=([^&#]+)/.exec(location.search);
      if (tok) saveCfg({ tok: tok, repo: (r ? decodeURIComponent(r[1]).trim() : "") || DEF_REPO, on: true });
      var s = location.search.replace(/([?&])evtok=[^&#]*/, "$1").replace(/([?&])evrepo=[^&#]*/, "$1")
        .replace(/&&+/g, "&").replace(/[?&]$/, "").replace(/^\?&/, "?");
      if (s === "?") s = "";
      if (history.replaceState) history.replaceState(history.state, "", location.pathname + s + location.hash);
    } catch (e) {}
  }
  function devName() {
    try {
      var c = JSON.parse(localStorage.getItem(SYNC_KEY) || "null");
      if (c && c.dev) return String(c.dev).slice(0, 24);
    } catch (e) {}
    return "";
  }

  /* ---------------- 队列（localStorage 环形；写在前、发在后，硬杀不丢） ---------------- */
  function qload() {
    try { var a = JSON.parse(localStorage.getItem(QKEY) || "[]"); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function qsave() { try { localStorage.setItem(QKEY, JSON.stringify(Q)); } catch (e) {} }
  function qtrim() {                                /* 返回是否动过（免空写 localStorage） */
    var t = Date.now(), n = Q.length;
    Q = Q.filter(function (x) { return x && typeof x.t === "number" && t - x.t <= MAXAGE; });
    if (Q.length > QCAP) Q = Q.slice(Q.length - QCAP);
    return Q.length !== n;
  }

  /* meta：页内细节（路径/查询）；凭据样参数一律抹去，不进配对 */
  var SECRET_RE = /(tok|token|pat|pass|pw|key|secret|auth|gp)$/i;
  function scrubQS() {
    var s = "";
    try { s = (location.search || "") + (location.hash || ""); } catch (e) { return ""; }
    if (!s) return "";
    s = s.replace(/([?&#]|^)([A-Za-z0-9_\-]+)=([^&#]*)/g, function (all, sep, k, v) {
      return SECRET_RE.test(k) ? sep + k + "=…" : all;
    });
    return s.slice(0, 80);
  }
  function meta() {
    var m = {}, d;
    try { if (location.pathname) m.p = String(location.pathname).slice(0, 80); } catch (e) {}
    var q = scrubQS(); if (q) m.q = q;
    d = devName(); if (d) m.d = d;
    return m;
  }

  function log(t, kind, m) {
    Q.push({ t: t, a: APP, e: kind, m: m, id: newId(t) });
    qtrim(); qsave();                               /* 写在前、发在后：硬杀/闪退不丢事件 */
  }
  function wire(x) {
    var o = { ts: isoTs(x.t), dev: "site", app: x.a, event: x.e, id: x.id };
    if (x.m && nk(x.m)) o.meta = x.m;
    return o;
  }

  /* ---------------- 进出 ---------------- */
  function openSeg() {
    if (seg || !INIT || blocked()) return;
    var t = Date.now();
    seg = { t: t };
    log(t, "open", meta());
    sched(2000);                       /* 尽快上屏：平台「此刻」靠这条 open 认在用 */
  }
  function closeSeg(hard) {
    if (!seg || !INIT || blocked()) return;
    var t = Date.now(), m = meta();
    m.s = Math.round((t - seg.t) / 1000);
    seg = null;
    log(t, "close", m);
    flush(!!hard);                     /* 离页：keepalive 直发（sendBeacon 不能带 Authorization 头） */
  }

  /* ---------------- 上传 ---------------- */
  function sched(ms) {
    if (tmr || !INIT || blocked()) return;
    try { tmr = setTimeout(function () { tmr = 0; flush(false); }, ms); } catch (e) { tmr = 0; }
  }
  function cool() { coldT = Date.now() + BACKOFF[Math.min(failN, BACKOFF.length - 1)]; failN++; }

  function putOnce(t, body, keepalive) {
    var path = "/repos/" + cfg.repo + "/contents/ev/site/" + bjYmd(t) + "/" + bjHms(t) + "-" + rnd() + ".jsonl";
    var h = { "Authorization": "Bearer " + cfg.tok, "Accept": "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" };
    var o = { method: "PUT", headers: h, body: JSON.stringify(body) };
    if (keepalive) o.keepalive = true;
    else { try { if (window.AbortSignal && AbortSignal.timeout) o.signal = AbortSignal.timeout(20000); } catch (e) {} }
    return fetch(API + path, o);
  }

  function flush(keepalive) {
    if (!INIT || blocked()) return;
    if (busy && !keepalive) return;               /* 离页一发不可挡：宁可重发（id 去重）也不吞 close */
    if (qtrim()) qsave();
    if (!Q.length) return;
    loadCfg();
    if (!enabled()) return;                       /* fail-closed：无 token 静默，事件留队列候配置 */
    if (Date.now() < coldT) return;
    var batch = Q.slice(0, BATCH);
    var ids = {}, i;
    for (i = 0; i < batch.length; i++) ids[batch[i].id] = 1;
    var text = batch.map(function (x) { return JSON.stringify(wire(x)); }).join("\n") + "\n";
    var body = { message: "ev site", content: b64e(text) };
    var t = Date.now();
    busy = true;
    var done = function (ok) {
      busy = false;
      if (ok) {
        failN = 0; coldT = 0;
        Q = Q.filter(function (x) { return !ids[x.id]; });
        qsave();
        if (Q.length) sched(1500);                /* 余量续发 */
      } else cool();
    };
    var go = function (retry) {
      return putOnce(t, body, keepalive).then(function (r) {
        if (r && (r.status === 200 || r.status === 201)) { done(true); return; }
        if (r && r.status === 422 && !retry) return go(true);   /* 撞名：新随机名再来一次 */
        done(false);
      }).catch(function () { done(false); });
    };
    try { go(false); } catch (e) { busy = false; cool(); }
  }

  /* ---------------- 装配 ---------------- */
  function init(opt) {
    if (INIT) return;                              /* 幂等 */
    opt = opt || {};
    APP = String(opt.app || "site").slice(0, 24);
    BLK = (typeof opt.blocked === "function") ? opt.blocked : null;
    if (!webPage()) return;                        /* file:// 等非站形态：整件不上场 */
    if (blocked()) return;                         /* 惰化：零监听/零定时器/零网络/零写入 */
    INIT = true;
    takeTok();
    Q = qload();
    try {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") closeSeg(true); else openSeg();
      });
      window.addEventListener("pagehide", function () { closeSeg(true); });
      window.addEventListener("pageshow", function () {
        if (document.visibilityState !== "hidden") openSeg();
      });
    } catch (e) {}
    try { setInterval(function () { flush(false); }, 60000); } catch (e) {}
    if (document.visibilityState === "hidden") sched(3000);   /* 后台开页：只补传旧队列 */
    else openSeg();
  }

  return {
    init: init, flush: flush,
    open: openSeg, close: closeSeg,
    setToken: function (tok, repo) { saveCfg({ tok: String(tok || "").trim(), repo: repo || DEF_REPO, on: true }); },
    _q: function () { return Q; },
    _wire: wire,
    _cfg: function () { return loadCfg(); }
  };
})();
