/**
 * rightbar-driver —— host 侧：右推栏浏览器驱动工具（模型-facing）
 * ============================================================================
 * 任务目的（玥玥 2026-10-24 对齐）：DSH 右推栏里的内置浏览器（官方
 * ui-sidebar-browser 标签页）变成可操纵的——她能看、能点、能输网址，
 * 我能操控。开门走官方公开 API：ctx.sidebarRight.openTab('browser', {...})。
 *
 * 本插件固化的是完整流程（全部经真机副本端到端实证）：
 *   零件层：给官方 slots 补 provideRoot/installScope（桌面包旧构建缺方法，
 *           不补则官方服务链整条失活、右推栏浏览器根本不存在）；
 *           给 window.dshDesktop 补 keyboard 遥控器（官方 shortcuts 服务
 *           构造时必检，缺失即抛 Desktop keyboard bridge unavailable）。
 *   驱动层：本文件注册 6 个工具（裸 JSON Schema 参数，照 tool-browser
 *           官方姿势），经 webServer 命令通道派给 client 半边执行。
 *   注意：web profile 还需在 cordis.patch.yml 启用 browser 类型
 *         （- id: ui-sidebar-browser / disabled: false）；desktop 默认启用。
 *
 * 通信模式照官方本地插件正路（browser-controller 实证）：ctx.effect 包裹
 * webServer.register，host 内存队列 + client 轮询取命令、POST 回结果。
 */
// defineTool 的双轨装载：真机桌面版走 asar 绝对路径（她 35 个官方本地
// 插件的统一约定），副本（npm 树 DSH）回退裸包名。动态 import + try 回退，
// 因为 ESM 静态 import 无法两轨兼容（asar 路径副本 loader 不认、裸包名
// 真机 profile node_modules 没装）。
let defineTool;
try {
  ({ defineTool } = await import('file:///C:/Users/ASUS/AppData/Local/Programs/DeepSeek%20Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'));
} catch {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
}

// 截图与导出件落盘目录：DSH_HOME 下单独一格，重启不清、便于回看。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { connect as netConnect } from 'node:net';

const DSH_BASE = process.env.DSH_HOME || join(homedir(), '.dsh');
const SHOT_DIR = join(DSH_BASE, 'rightbar-shots');
const DOWNLOAD_DIR = join(DSH_BASE, 'rightbar-downloads');

/**
 * 访问历史。
 * DSH 自己的 webview 只在会话内保留导航历史（前进后退够用），
 * 但关掉之后不记「以前开过哪些网页」。这里自己记一份，跨会话、跨重启都在。
 * 存成一行一条的 JSON，方便顺手 grep，也方便她自己打开看。
 */
const HISTORY_FILE = join(DSH_BASE, 'rightbar-history.jsonl');
const HISTORY_MAX = 2000;

function readHistory(limit) {
  // diag.error 初始必须是空串而不是 null：输出 schema 把它声明成 string，
  // null 会被官方的 INVALID_TOOL_OUTPUT 拦掉（2026-10-25 实测踩到）。
  const diag = { file: HISTORY_FILE, exists: false, lines: 0, error: '' };
  try {
    diag.exists = existsSync(HISTORY_FILE);
    if (!diag.exists) return { entries: [], diag };
    const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '');
    diag.lines = lines.length;
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* 坏行跳过 */ }
    }
    return { entries: out, diag };
  } catch (e) {
    diag.error = String(e && e.message);
    return { entries: [], diag };
  }
}

function appendHistory(entry) {
  try {
    mkdirSync(join(process.env.DSH_HOME || join(homedir(), '.dsh')), { recursive: true });
    let lines = [];
    if (existsSync(HISTORY_FILE)) {
      lines = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '');
    }
    // 同一个网址连着访问只留最近一条，避免刷屏
    const last = lines.length > 0 ? (() => { try { return JSON.parse(lines[lines.length - 1]); } catch { return null; } })() : null;
    if (last !== null && last.url === entry.url) {
      lines[lines.length - 1] = JSON.stringify(entry);
    } else {
      lines.push(JSON.stringify(entry));
    }
    if (lines.length > HISTORY_MAX) lines = lines.slice(lines.length - HISTORY_MAX);
    writeFileSync(HISTORY_FILE, lines.join('\n') + '\n');
    return true;
  } catch { return false; }
}

/**
 * 操作日志。
 * 每一次派给右推栏的命令都记一行，排查「刚才到底点了什么」时不用翻会话。
 * 与访问历史同层落盘，跨重启都在。
 */
const OPS_FILE = join(DSH_BASE, 'rightbar-ops.jsonl');
const OPS_MAX = 2000;

function summarizeArgs(command) {
  const out = {};
  for (const key of Object.keys(command)) {
    if (key === 'action' || key === 'requestId') continue;
    const value = command[key];
    if (typeof value === 'string') out[key] = value.length > 120 ? value.slice(0, 120) + '…' : value;
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function appendOp(entry) {
  try {
    mkdirSync(DSH_BASE, { recursive: true });
    let lines = existsSync(OPS_FILE) ? readFileSync(OPS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '') : [];
    const withSeq = { seq: nextOpSeq(lines), ...entry };
    lines.push(JSON.stringify(withSeq));
    if (lines.length > OPS_MAX) lines = lines.slice(lines.length - OPS_MAX);
    writeFileSync(OPS_FILE, lines.join('\n') + '\n');
  } catch { /* 记账失败不影响动作本身 */ }
}

function nextOpSeq(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const seq = Number(JSON.parse(lines[i]).seq);
      if (Number.isFinite(seq)) return seq + 1;
    } catch { /* 坏行继续往前找 */ }
  }
  return 1;
}

function readOps(limit) {
  try {
    if (!existsSync(OPS_FILE)) return [];
    const lines = readFileSync(OPS_FILE, 'utf8').split('\n').filter((l) => l.trim() !== '');
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try { out.push(JSON.parse(lines[i])); } catch { /* 坏行跳过 */ }
    }
    return out;
  } catch { return []; }
}

/**
 * 动作白名单。
 * 这是软护栏，不是安全边界：防止只读任务里被误点、误提交。
 * 拦的是工具调用这一层，拦不住页面自己弹出来的东西。
 */
const POLICY_FILE = join(DSH_BASE, 'rightbar-policy.json');
const COOKIE_FILE = join(DSH_BASE, 'rightbar-cookies.json');
const READ_ONLY = new Set(['open', 'navigate', 'read', 'info', 'shot', 'shotfull', 'find', 'zoom', 'tabs', 'history', 'health', 'controls', 'captcha', 'a11y', 'scrape', 'wait', 'ops', 'content']);
const ACTION_TOOL = {
  open: 'rightbar_open', navigate: 'rightbar_navigate', read: 'rightbar_read', shot: 'rightbar_shot',
  shotfull: 'rightbar_shot_full', wait: 'rightbar_wait', select: 'rightbar_select', check: 'rightbar_check',
  scroll: 'rightbar_scroll', history: 'rightbar_nav', eval: 'rightbar_eval', info: 'rightbar_info',
  tabs: 'rightbar_tabs', zoom: 'rightbar_zoom', find: 'rightbar_find', pdf: 'rightbar_pdf',
  style: 'rightbar_style', health: 'rightbar_health', key: 'rightbar_key', controls: 'rightbar_controls',
  captcha: 'rightbar_captcha', a11y: 'rightbar_a11y', scrape: 'rightbar_scrape', download: 'rightbar_download',
  click: 'rightbar_click', fill: 'rightbar_fill', close: 'rightbar_close', ops: 'rightbar_ops',
  clickat: 'rightbar_click', type: 'rightbar_type', setvalue: 'rightbar_set_value',
  cookies: 'rightbar_cookies', sessionreset: 'rightbar_session_reset', content: 'rightbar_content',
};

function readPolicy() {
  try {
    const raw = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
    if (raw === null || typeof raw !== 'object') return { mode: 'off', allow: [] };
    return {
      mode: raw.mode === 'readonly' || raw.mode === 'custom' ? raw.mode : 'off',
      allow: Array.isArray(raw.allow) ? raw.allow.map(String) : [],
    };
  } catch { return { mode: 'off', allow: [] }; }
}

function writePolicy(policy) {
  mkdirSync(DSH_BASE, { recursive: true });
  writeFileSync(POLICY_FILE, JSON.stringify(policy, null, 2));
}

/**
 * Cookie 存档。
 * 同一个站点反复登录很费时间，这里按名字存一份，下次直接灌回去。
 * 只存页面脚本能读到的 Cookie；HttpOnly 的那些浏览器不给读，存不了。
 */
function readCookieStore() {
  try {
    const raw = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
    return raw !== null && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function writeCookieStore(store) {
  mkdirSync(DSH_BASE, { recursive: true });
  writeFileSync(COOKIE_FILE, JSON.stringify(store, null, 2));
}

/**
 * 联网搜索。
 * 官方搜索从 2026-11-01 起按次收费，这里把 ctx.web 的搜索提供方换成我们自己的：
 * 先问自建 SearXNG（腾讯云 127.0.0.1:8888，本机经 SSH 隧道访问），
 * 再问 Tavily（有密钥才用），最后用右推栏真浏览器兜底。
 * 三层都不通才报错，错误里会写清每一层为什么失败。
 */
const SEARCH_CONFIG_FILE = join(DSH_BASE, 'search-sources.json');
const DEFAULT_SEARCH_CONFIG = {
  searxng: {
    url: 'http://127.0.0.1:18888',
    tunnel: { host: '124.221.10.56', user: 'ubuntu', localPort: 18888, remotePort: 8888 },
  },
  tavilyKey: '',
  browserFallback: true,
};

function readSearchConfig() {
  try {
    if (!existsSync(SEARCH_CONFIG_FILE)) {
      mkdirSync(DSH_BASE, { recursive: true });
      writeFileSync(SEARCH_CONFIG_FILE, JSON.stringify(DEFAULT_SEARCH_CONFIG, null, 2));
      return DEFAULT_SEARCH_CONFIG;
    }
    const raw = JSON.parse(readFileSync(SEARCH_CONFIG_FILE, 'utf8'));
    return {
      ...DEFAULT_SEARCH_CONFIG,
      ...(raw && typeof raw === 'object' ? raw : {}),
      searxng: { ...DEFAULT_SEARCH_CONFIG.searxng, ...((raw && raw.searxng) || {}) },
    };
  } catch { return DEFAULT_SEARCH_CONFIG; }
}

function portOpen(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const socket = netConnect({ port, host });
    const finish = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

let tunnelChild = null;

/** 本机到服务器的加密隧道：只有本地端口，不开任何公网入口。 */
async function ensureTunnel(cfg) {
  const tunnel = cfg.searxng && cfg.searxng.tunnel;
  let port = 80;
  try { port = Number(new URL(cfg.searxng.url).port || (new URL(cfg.searxng.url).protocol === 'https:' ? 443 : 80)); } catch { return false; }
  if (await portOpen(port)) return true;
  if (!tunnel || !tunnel.host) return false;
  const sshExe = join(process.env.WINDIR || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
  const args = [
    '-N',
    '-L', `127.0.0.1:${port}:127.0.0.1:${tunnel.remotePort}`,
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    `${tunnel.user}@${tunnel.host}`,
  ];
  try {
    tunnelChild = spawn(sshExe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    tunnelChild.unref();
  } catch { return false; }
  const started = Date.now();
  // 等隧道最多 6 秒。原来 12 秒，加上取数 20 秒，最坏要 32 秒才回退，
  // 一次搜索把工具调用拖死；压到 6 秒后最坏 14 秒就能落到下一层。
  while (Date.now() - started < 6000) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (await portOpen(port)) return true;
  }
  return false;
}

async function fetchJsonWithTimeout(url, options, timeoutMs, outerSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
  }
}

function searchLimit(request) {
  const wanted = request && Number(request.maxResults);
  return Number.isFinite(wanted) && wanted > 0 ? Math.min(Math.round(wanted), 20) : 8;
}

async function searxngSearch(cfg, request, signal) {
  const up = await ensureTunnel(cfg);
  if (!up) throw new Error('隧道没通，本地端口没有监听');
  const url = new URL(String(cfg.searxng.url).replace(/\/$/, '') + '/search');
  url.searchParams.set('q', String((request && request.query) || ''));
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'zh-CN');
  const data = await fetchJsonWithTimeout(url.toString(), { headers: { accept: 'application/json' } }, 8000, signal);
  const raw = Array.isArray(data.results) ? data.results : [];
  const limit = searchLimit(request);
  const seen = new Set();
  const sources = [];
  for (const item of raw) {
    if (!item || typeof item.url !== 'string' || item.url === '' || seen.has(item.url)) continue;
    seen.add(item.url);
    const one = { url: item.url };
    if (typeof item.title === 'string' && item.title !== '') one.title = item.title;
    if (typeof item.content === 'string' && item.content !== '') one.snippet = item.content.slice(0, 300);
    if (typeof item.publishedDate === 'string' && item.publishedDate !== '') one.publishedAt = item.publishedDate;
    sources.push(one);
    if (sources.length >= limit) break;
  }
  return { sources, truncated: raw.length > sources.length };
}

async function tavilySearch(cfg, request, signal) {
  const limit = searchLimit(request);
  const body = {
    api_key: cfg.tavilyKey,
    query: String((request && request.query) || ''),
    max_results: limit,
    search_depth: 'basic',
  };
  const data = await fetchJsonWithTimeout('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.tavilyKey },
    body: JSON.stringify(body),
  }, 20000, signal);
  const raw = Array.isArray(data.results) ? data.results : [];
  const sources = raw.filter((r) => r && typeof r.url === 'string' && r.url !== '').slice(0, limit).map((r) => {
    const one = { url: r.url };
    if (r.title) one.title = String(r.title);
    if (r.content) one.snippet = String(r.content).slice(0, 300);
    return one;
  });
  return { sources, truncated: raw.length > sources.length };
}

/** 官方 ctx.web 的搜索提供方：id + available() + search()。 */
const SEARCH_PROVIDER_STATE = { registered: false, id: 'moon-local', error: null };

/**
 * 搜索健康记账。只放内存，不落盘。
 * available() 靠它做"廉价局部判断"：官方文档明确要求可用性检查不发起网络调用，
 * 所以这里不探端口，只读上一轮搜索的结果，失败后进入冷静期。
 */
const SEARCH_HEALTH = { downUntil: 0, cooldownMs: 60000, lastError: '', lastOkAt: 0, lastFailAt: 0 };

function markSearchOk() {
  SEARCH_HEALTH.downUntil = 0;
  SEARCH_HEALTH.lastError = '';
  SEARCH_HEALTH.lastOkAt = Date.now();
}

function markSearchDown(reason) {
  SEARCH_HEALTH.downUntil = Date.now() + SEARCH_HEALTH.cooldownMs;
  SEARCH_HEALTH.lastError = String(reason || '').slice(0, 300);
  SEARCH_HEALTH.lastFailAt = Date.now();
}

class MoonSearchProvider {
  id = 'moon-local';
  constructor(dispatch) { this.dispatch = dispatch; }
  available() {
    SEARCH_PROVIDER_STATE.availableCalls = (SEARCH_PROVIDER_STATE.availableCalls || 0) + 1;
    SEARCH_PROVIDER_STATE.downUntil = SEARCH_HEALTH.downUntil;
    SEARCH_PROVIDER_STATE.lastError = SEARCH_HEALTH.lastError;
    // 上一轮三层全挂之后的冷静期内报不可用，官方会立刻报
    // WEB_PROVIDER_UNAVAILABLE 或改选别的提供方，不会把搜索派过来白等。
    return Date.now() >= SEARCH_HEALTH.downUntil;
  }
  async search(request, signal) {
    SEARCH_PROVIDER_STATE.searchCalls = (SEARCH_PROVIDER_STATE.searchCalls || 0) + 1;
    SEARCH_PROVIDER_STATE.lastQuery = String((request && request.query) || '');
    const cfg = readSearchConfig();
    const notes = [];
    try {
      const found = await searxngSearch(cfg, request, signal);
      if (found.sources.length > 0) {
        SEARCH_PROVIDER_STATE.lastVia = 'searxng';
        SEARCH_PROVIDER_STATE.lastCount = found.sources.length;
        markSearchOk();
        return found;
      }
      notes.push('自建搜索没有结果');
    } catch (e) { notes.push('自建搜索失败: ' + String((e && e.message) || e)); }
    if (cfg.tavilyKey) {
      try {
        const found = await tavilySearch(cfg, request, signal);
        if (found.sources.length > 0) {
          SEARCH_PROVIDER_STATE.lastVia = 'tavily';
          SEARCH_PROVIDER_STATE.lastCount = found.sources.length;
          markSearchOk();
          return found;
        }
        notes.push('Tavily 没有结果');
      } catch (e) { notes.push('Tavily 失败: ' + String((e && e.message) || e)); }
    } else {
      notes.push('没有配置 Tavily 密钥');
    }
    if (cfg.browserFallback !== false) {
      try {
        const found = await this.dispatch({ action: 'searchweb', query: String((request && request.query) || ''), limit: searchLimit(request) }, 45000);
        if (found && Array.isArray(found.sources) && found.sources.length > 0) {
          SEARCH_PROVIDER_STATE.lastVia = 'browser';
          SEARCH_PROVIDER_STATE.lastCount = found.sources.length;
          markSearchOk();
          return { sources: found.sources, truncated: found.truncated === true };
        }
        notes.push('浏览器兜底没有结果: ' + ((found && found.error) || '未知原因'));
      } catch (e) { notes.push('浏览器兜底失败: ' + String((e && e.message) || e)); }
    }
    SEARCH_PROVIDER_STATE.lastError = notes.join('；');
    // 三层全挂：进冷静期，下一次 available() 直接报不可用，别让官方再派过来白等。
    markSearchDown(notes.join('；'));
    throw new Error('所有搜索源都不可用：' + notes.join('；'));
  }
}

export const name = 'rightbar-driver';
export const inject = ['webServer', 'tools', 'systemPrompt', 'web'];

const CHANNEL = 'default';

/* ============================================================================
 * 多元抓取：把「多远下载」那套镜像兜底搬到 ctx.web 的抓取链路上。
 * 直连打不开就自动换镜像，而不是直接报错。
 * 镜像表沿用玥玥 dlx.py 里验证过的那几个。
 * ==========================================================================*/

/** GitHub 系镜像：把原 URL 拼成镜像 URL。
 * 顺序按 2026-10-26 实测结果排：ghfast / gh-proxy 返回 200 可用，
 * kkgithub 连接失败、bgithub 返回 403，所以放到最后作备用。 */
const GITHUB_MIRRORS = [
  (u) => 'https://ghfast.top/' + u,
  (u) => 'https://gh-proxy.com/' + u,
  (u) => u.replace('https://github.com/', 'https://kkgithub.com/'),
  (u) => u.replace('https://github.com/', 'https://bgithub.xyz/'),
];

/** raw.githubusercontent.com/user/repo/branch/path -> CDN 的 user/repo@branch/path。
 * 注意顺序：ghfast / gh-proxy 在她本机实测 200；jsDelivr 与 Statically 在
 * 服务器上 200，但她本机 DNS 把 Cloudflare 系解析坏了、直连 fetch failed，
 * 所以 CDN 只能排在代理镜像后面。 */
function rawToCdn(u, template) {
  const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(u);
  return m === null ? u : template(m[1], m[2], m[3], m[4]);
}

const RAW_MIRRORS = [
  (u) => 'https://ghfast.top/' + u,
  (u) => 'https://gh-proxy.com/' + u,
  (u) => rawToCdn(u, (user, repo, branch, path) => `https://cdn.jsdelivr.net/gh/${user}/${repo}@${branch}/${path}`),
  (u) => rawToCdn(u, (user, repo, branch, path) => `https://cdn.statically.io/gh/${user}/${repo}/${branch}/${path}`),
  (u) => u.replace('https://raw.githubusercontent.com/', 'https://raw.kkgithub.com/'),
];

const CODELOAD_MIRRORS = [
  (u) => 'https://ghfast.top/' + u,
  (u) => 'https://gh-proxy.com/' + u,
];

/**
 * 按域名给出镜像候选（不含原地址；原地址永远先试）。
 * @param {string} url 原始地址
 * @returns {string[]} 镜像地址列表，可能为空
 */
function mirrorCandidates(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  const host = u.hostname.toLowerCase();
  const makers = host === 'github.com' ? GITHUB_MIRRORS
    : host === 'raw.githubusercontent.com' ? RAW_MIRRORS
      : host === 'codeload.github.com' ? CODELOAD_MIRRORS
        : host === 'api.github.com' ? [GITHUB_MIRRORS[0], GITHUB_MIRRORS[1]]
          : null;
  if (makers === null) return [];
  const out = [];
  for (const make of makers) {
    try {
      const candidate = make(url);
      if (candidate !== url && !out.includes(candidate)) out.push(candidate);
    } catch { /* 单个镜像拼不出来就跳过 */ }
  }
  return out;
}

/** 抓取健康记账，供 available() 做廉价判断。 */
const FETCH_STATE = { registered: false, id: 'moon-fetch', lastVia: '', lastError: '', mirrorHits: 0, directHits: 0 };

/**
 * 从字节头部嗅探字符集。
 * 中文站大量使用 GBK/GB2312，直接按 UTF-8 解会变乱码，
 * 官方 http 提供方有这一步，这里必须对齐。
 * @param {Uint8Array} bytes 响应字节
 * @param {string} ctype content-type 头
 * @returns {string} 可用的编码名
 */
function sniffCharset(bytes, ctype) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(ctype || '');
  if (fromHeader) return fromHeader[1].toLowerCase();
  // 只在头部 4KB 里找 <meta charset=...> 或 http-equiv
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.byteLength, 4096)));
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (meta) return meta[1].toLowerCase();
  const equiv = /content=["'][^"']*charset=([\w-]+)/i.exec(head);
  if (equiv) return equiv[1].toLowerCase();
  return 'utf-8';
}

/** 把响应体读成文本，带上限并做字符集转换。 */
async function readTextCapped(res, maxBytes) {
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const truncated = bytes.byteLength > maxBytes;
  const slice = truncated ? bytes.subarray(0, maxBytes) : bytes;
  const charset = sniffCharset(slice, String(res.headers.get('content-type') || ''));
  let text;
  try {
    text = new TextDecoder(charset === 'gb2312' ? 'gbk' : charset, { fatal: false }).decode(slice);
  } catch {
    text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
  }
  return { text, truncated };
}

/**
 * 带镜像兜底的抓取提供方。
 * 与官方 http 提供方行为一致（直连优先），只在直连失败或非 2xx 时才换镜像。
 */
class MoonFetchProvider {
  id = 'moon-fetch';
  available() {
    return true;
  }
  async fetch(request, signal) {
    const original = String((request && request.url) || '');
    if (original === '') throw new Error('抓取地址是空的');
    const attempts = [original, ...mirrorCandidates(original)];
    const notes = [];
    for (let i = 0; i < attempts.length; i += 1) {
      const url = attempts[i];
      if (signal && signal.aborted) throw new Error('抓取被取消');
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8,*/*;q=0.7',
          },
          ...(signal ? { signal } : {}),
        });
        if (!res.ok) {
          notes.push(`${i === 0 ? '直连' : '镜像'} HTTP ${res.status}`);
          try { await res.body?.cancel(); } catch { /* 取消失败不影响换下一个 */ }
          continue;
        }
        const { text, truncated } = await readTextCapped(res, 5e6);
        const ctype = String(res.headers.get('content-type') || '');
        const kind = /html|xml/i.test(ctype) || /^\s*</.test(text.slice(0, 200)) ? 'html' : 'text';
        if (i === 0) FETCH_STATE.directHits += 1;
        else FETCH_STATE.mirrorHits += 1;
        FETCH_STATE.lastVia = i === 0 ? 'direct' : 'mirror';
        FETCH_STATE.lastError = '';
        return {
          url: res.url || url,
          statusCode: res.status,
          body: { kind, content: text },
          truncated,
        };
      } catch (e) {
        notes.push(`${i === 0 ? '直连' : '镜像'} ${String((e && e.message) || e).slice(0, 80)}`);
      }
    }
    FETCH_STATE.lastError = notes.join('；');
    const mirrorNote = mirrorCandidates(original).length === 0
      ? '该域名没有配镜像'
      : `已试 ${attempts.length} 个地址（含 ${attempts.length - 1} 个镜像）`;
    throw new Error(`抓取失败：${mirrorNote}。逐项原因：${notes.join('；')}`);
  }
}

export function apply(ctx) {
  const channels = new Map();
  const getChannel = (key) => {
    if (!channels.has(key)) channels.set(key, { queue: [], waiters: [] });
    return channels.get(key);
  };
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve(null); } });
  });

  const dispatch = (command, timeoutMs = 30000) => new Promise((resolve) => {
    const policy = readPolicy();
    const allowed = policy.mode === 'readonly' ? READ_ONLY : new Set(policy.allow);
    if (policy.mode !== 'off' && !allowed.has(command.action)) {
      const toolName = ACTION_TOOL[command.action] || command.action;
      const label = policy.mode === 'readonly' ? '只读模式' : '自定义白名单';
      appendOp({ at: new Date().toISOString(), action: command.action, ok: false, blocked: true, args: summarizeArgs(command) });
      resolve({ error: '动作白名单拦截：当前是' + label + '，不允许 ' + toolName });
      return;
    }
    const channel = getChannel(CHANNEL);
    const started = Date.now();
    const requestId = 'rb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const timer = setTimeout(() => {
      const idx = channel.waiters.findIndex((w) => w.requestId === requestId);
      if (idx >= 0) channel.waiters.splice(idx, 1);
      appendOp({ at: new Date().toISOString(), action: command.action, ok: false, error: 'timeout', ms: Date.now() - started, args: summarizeArgs(command) });
      console.log('[rightbar-driver] timeout', requestId, JSON.stringify(command));
      resolve({ error: 'timeout: 右推栏客户端无应答（页面未打开或桥未就绪）' });
    }, timeoutMs);
    channel.waiters.push({ requestId, resolve: (v) => {
      clearTimeout(timer);
      appendOp({ at: new Date().toISOString(), action: command.action, ok: !(v && v.error), error: v && v.error ? String(v.error).slice(0, 200) : undefined, ms: Date.now() - started, args: summarizeArgs(command) });
      console.log('[rightbar-driver] result', requestId, JSON.stringify(command), '=>', JSON.stringify(v));
      resolve(v);
    } });
    channel.queue.push({ requestId, ...command });
  });

  // 自检口：暴露插件内部看到的路径与环境，排查「读不到文件」这类问题用。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/rightbar-api/diag',
    handler: async (req, res) => {
      const got = readHistory(50);
      sendJson(res, 200, {
        ok: true,
        dshHome: process.env.DSH_HOME || null,
        historyFile: HISTORY_FILE,
        shotDir: SHOT_DIR,
        historyExists: got.diag.exists,
        historyLines: got.diag.lines,
        historyError: got.diag.error,
        historySample: got.entries.slice(0, 3),
        searchProvider: SEARCH_PROVIDER_STATE,
        searchConfig: (() => {
          const cfg = readSearchConfig();
          return { url: cfg.searxng.url, tavily: cfg.tavilyKey !== '', browserFallback: cfg.browserFallback !== false };
        })(),
      });
    },
  }));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/rightbar-api/cmd',
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'only GET' });
      const cmd = getChannel(CHANNEL).queue.shift();
      sendJson(res, 200, cmd ? { ok: true, command: cmd } : { ok: false });
    },
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/rightbar-api/res',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'only POST' });
      const payload = await readBody(req);
      if (payload === null || typeof payload.requestId !== 'string') return sendJson(res, 400, { ok: false, error: 'invalid payload' });
      const channel = getChannel(CHANNEL);
      const idx = channel.waiters.findIndex((w) => w.requestId === payload.requestId);
      if (idx >= 0) channel.waiters.splice(idx, 1)[0].resolve(payload.value !== undefined ? payload.value : { error: payload.error });
      sendJson(res, 200, { ok: true });
    },
  }));
  // 二进制收件口：截图（PNG）与导出的 PDF 都从这里落地，只回路径。
  // 几 MB 的 base64 不进工具输出，模型按路径取文件。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/rightbar-api/shot',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'only POST' });
      const payload = await readBody(req);
      const dataUrl = payload && payload.dataUrl;
      if (typeof dataUrl !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 dataUrl' });
      const m = dataUrl.match(/^data:(image\/[a-zA-Z]+|application\/pdf);base64,(.+)$/);
      if (m === null) return sendJson(res, 400, { ok: false, error: 'dataUrl 格式不对' });
      const isPdf = m[1] === 'application/pdf';
      const ext = isPdf ? 'pdf' : (m[1].split('/')[1] || 'png');
      try {
        const buf = Buffer.from(m[2], 'base64');
        mkdirSync(SHOT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const prefix = isPdf ? 'page-' : 'shot-';
        const file = join(SHOT_DIR, prefix + stamp + '-' + Math.random().toString(36).slice(2, 6) + '.' + ext);
        writeFileSync(file, buf);
        console.log('[rightbar-driver] saved', file, buf.length);
        sendJson(res, 200, { ok: true, path: file, bytes: buf.length });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e && e.message) });
      }
    },
  }));

  // 下载收件口：页面里取到的文件字节（base64）从这里落盘到 DSH_HOME/rightbar-downloads。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/rightbar-api/file',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'only POST' });
      const payload = await readBody(req);
      if (payload === null || typeof payload.base64 !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 base64' });
      try {
        const buf = Buffer.from(payload.base64, 'base64');
        mkdirSync(DOWNLOAD_DIR, { recursive: true });
        const rawName = typeof payload.name === 'string' && payload.name !== '' ? payload.name : 'download.bin';
        const safe = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        const file = join(DOWNLOAD_DIR, Date.now().toString(36) + '-' + safe);
        writeFileSync(file, buf);
        console.log('[rightbar-driver] downloaded', file, buf.length);
        sendJson(res, 200, { ok: true, path: file, bytes: buf.length });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e && e.message) });
      }
    },
  }));

  // 输出 schema 必须与 execute 真实返回的字段对齐。官方对 output 做严格校验，
  // 声明成空 properties 会把返回值里的 error/frames/note 判成"未声明属性"，
  // 工具结果就被拦成"返回了无效输出"（2026-10-24 副本实测踩到）。
  const OUT_SCHEMA = {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean', description: '动作是否成功' },
      error: { type: 'string', description: '失败原因，成功时不出现' },
      note: { type: 'string', description: '附加说明' },
      frames: { type: 'number', description: '已上屏的浏览器框架数量' },
      via: { type: 'string', description: '导航实际走的通道' },
      url: { type: 'string', description: '当前页面地址' },
      title: { type: 'string', description: '当前页面标题' },
      text: { type: 'string', description: '页面正文文本' },
      refs: {
        type: 'array',
        description: '可交互元素清单',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ref: { type: 'string' },
            tag: { type: 'string' },
            label: { type: 'string' },
          },
        },
      },
      framesFound: { type: 'number', description: '关闭时发现的框架数' },
      width: { type: 'number', description: '网页框当前宽度，像素（resize 用）' },
      height: { type: 'number', description: '网页框当前高度，像素（resize 用）' },
      asked: { type: 'number', description: '请求设置的宽度，像素；若与实际生效值 width 不一致，说明请求值超出了本插件夹紧的上限（容器可用宽度，防止把手飞出视口抓不到）' },
      alreadyHad: { type: 'boolean', description: '拖动把手本来就在，未重复挂载' },
      x: { type: 'number', description: '坐标点击的实际横坐标' },
      y: { type: 'number', description: '坐标点击的实际纵坐标' },
      box: {
        type: 'object',
        additionalProperties: true,
        description: '元素在视口中的位置与尺寸，坐标点击用',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
        },
      },
      path: { type: 'string', description: '截图文件在本机的绝对路径' },
      bytes: { type: 'number', description: '截图文件字节数' },
      waited: { type: 'number', description: '等待实际耗时，毫秒' },
      ready: { type: 'string', description: '页面加载状态' },
      picked: { type: 'string', description: '下拉框实际选中的值' },
      label: { type: 'string', description: '下拉框选中项的文字' },
      options: { type: 'array', items: { type: 'string' }, description: '下拉框可选项清单（未匹配时给出）' },
      checked: { type: 'boolean', description: '复选框或单选框当前状态' },
      already: { type: 'boolean', description: '状态本来就对，未再操作' },
      result: { type: 'json', description: '页面内脚本的返回值' },
      tabs: {
        type: 'array',
        description: '标签页清单',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            tabId: { type: 'string' },
            kind: { type: 'string' },
            sessionId: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
      count: { type: 'number', description: '标签页数量' },
      tabId: { type: 'string', description: '目标标签页标识' },
      factor: { type: 'number', description: '当前缩放倍数，1 为原始大小' },
      matches: { type: 'number', description: '页内查找命中数量' },
      active: { type: 'number', description: '当前停在第几个命中项' },
      key: { type: 'string', description: '注入样式的标识，撤销时用它' },
      removed: { type: 'string', description: '已撤销的样式标识' },
      crashed: { type: 'boolean', description: '页面进程是否崩溃' },
      loading: { type: 'boolean', description: '是否仍在加载' },
      muted: { type: 'boolean', description: '是否静音' },
      audible: { type: 'boolean', description: '是否正在出声' },
      entries: {
        type: 'array',
        description: '访问历史条目，最近的在前',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            url: { type: 'string' },
            at: { type: 'string' },
            via: { type: 'string' },
          },
        },
      },
      diag: {
        type: 'object',
        additionalProperties: true,
        description: '读取历史时用的文件与状态，排查用',
        properties: {
          file: { type: 'string' },
          exists: { type: 'boolean' },
          lines: { type: 'number' },
          error: { type: 'string' },
        },
      },
    },
  };

  const textOut = (fn) => ({ schema: OUT_SCHEMA, render: (_a, value) => [{ type: 'text', text: fn(value) }] });

  ctx.tools.register(defineTool({
    name: 'rightbar_open',
    description: '在 DSH 右推栏打开内置浏览器标签页（官方 ui-sidebar-browser），可选随标签页打开一个网址。这是操纵右推栏浏览器的第一步；若报座位未挂载，先确保当前有会话在屏幕上。',
    parameters: { url: { type: 'string', description: '可选，要随标签页打开的 HTTP(S) 网址；不给则只开空白标签页' } },
    output: textOut((v) => v && v.error ? '失败: ' + v.error : '已打开右推栏浏览器标签页' + (v && v.frames ? '（框架 ' + v.frames + ' 个）' : '') + (v && v.note ? '；' + v.note : '')),
    async execute(args) {
      const r = await dispatch({ action: 'open', url: args.url || '' });
      if (args.url && (!r || !r.error)) {
        appendHistory({ url: args.url, at: new Date().toISOString(), via: 'open' });
      }
      return r;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_navigate',
    description: '让右推栏内置浏览器导航到指定网址（需要已用 rightbar_open 打开标签页）。',
    parameters: { url: { type: 'string', required: true, description: '要访问的 HTTP(S) 网址' } },
    output: textOut((v) => v && v.error ? '失败: ' + v.error : '已导航（' + (v.via || 'ok') + '）'),
    async execute(args) {
      const r = await dispatch({ action: 'navigate', url: args.url });
      if (args.url && (!r || !r.error)) {
        appendHistory({ url: args.url, at: new Date().toISOString(), via: 'navigate' });
      }
      return r;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_read',
    description: '读取右推栏内置浏览器当前页面的文本与可交互元素清单（元素带 ref，供 rightbar_click/rightbar_fill 使用）。ref 同一次 read 内有效，页面变化后重新 read。',
    parameters: {},
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      const lines = [];
      lines.push('URL: ' + v.url);
      lines.push('标题: ' + v.title);
      if (v.refs && v.refs.length) {
        lines.push('可交互元素（用 ref 点击或填字）:');
        for (const r of v.refs) lines.push(`- [${r.ref}] <${r.tag}> ${r.label || '(无标签)'}`);
      } else lines.push('（本页没有可交互元素）');
      lines.push('', '页面文本:', (v.text || '').slice(0, 20000));
      return lines.join('\n');
    }),
    async execute() { return dispatch({ action: 'read' }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_shot',
    description: '给右推栏内置浏览器当前页面截图，返回本机图片文件路径，可用 read_image 查看。截的是网页内容本身，不受其他窗口遮挡影响。仅桌面版可用；Web 版（iframe 渲染）没有这个能力，会明确报错。',
    parameters: {},
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      return '已截图: ' + v.path + (v.bytes ? '（' + Math.round(v.bytes / 1024) + ' KB）' : '');
    }),
    async execute() { return dispatch({ action: 'shot' }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_click',
    description: '点击右推栏内置浏览器页面里的元素（用 rightbar_read 拿到的 ref，或 CSS 选择器）。也可以给 x、y 按坐标点，用来点画布、地图、自绘控件这类没有选择器的位置。每个观察周期最多一个状态改变动作，动作后重新 read。',
    parameters: {
      ref: { type: 'string', description: 'rightbar_read 返回的 ref（dsh-ref-N），或 CSS 选择器；给坐标时可不填' },
      x: { type: 'number', description: '页面视口内的横坐标，左上角为 0' },
      y: { type: 'number', description: '页面视口内的纵坐标，左上角为 0' },
    },
    output: textOut((v) => v && v.error ? '失败: ' + v.error : (v.ok ? (v.x !== undefined ? '已点击坐标 ' + v.x + ',' + v.y : '已点击') : '未点中: ' + (v.error || '元素未找到'))),
    async execute(args) {
      if (typeof args.x === 'number' && typeof args.y === 'number') {
        return dispatch({ action: 'clickat', x: args.x, y: args.y });
      }
      if (!args.ref) return { error: '要给 ref，或者给 x、y 坐标' };
      return dispatch({ action: 'click', ref: args.ref });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_fill',
    description: '在右推栏内置浏览器页面的输入框填字（用 ref 或 CSS 选择器定位元素）。',
    parameters: {
      ref: { type: 'string', required: true, description: '输入框的 ref（dsh-ref-N）或 CSS 选择器' },
      value: { type: 'string', required: true, description: '要填入的文字' },
    },
    output: textOut((v) => v && v.error ? '失败: ' + v.error : (v.ok ? '已填入' : '未填入: ' + (v.error || '元素未找到'))),
    async execute(args) { return dispatch({ action: 'fill', ref: args.ref, value: args.value }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_wait',
    description: '等页面条件成立再往下走。页面是异步渲染的，导航或点击后立刻读常拿到空白或旧内容；拿不准时先 wait 再 read。不指定 selector 和 text 时，等的是页面加载完成。',
    parameters: {
      selector: { type: 'string', description: '要等的 CSS 选择器，例如 #result 或 .list-item' },
      text: { type: 'string', description: '要等的文字片段（selector 不给时按文字找）' },
      state: { type: 'string', description: 'visible（默认，等出现）或 hidden（等消失）' },
      timeout: { type: 'number', description: '最长等待毫秒数，默认 10000' },
    },
    output: textOut((v) => v && v.error ? '失败: ' + v.error : '已就绪（等了 ' + (v.waited || 0) + ' 毫秒，页面状态 ' + (v.ready || '未知') + '）'),
    async execute(args) {
      // 等多久，命令通道就要放行多久，否则工具会先被自己的超时掐断。
      const limit = typeof args.timeout === 'number' && args.timeout > 0 ? args.timeout : 10000;
      return dispatch({ action: 'wait', selector: args.selector || '', text: args.text || '', state: args.state || 'visible', timeout: limit }, limit + 10000);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_select',
    description: '在下拉框里选一项。按选项的值或显示文字匹配，两种都试。',
    parameters: {
      ref: { type: 'string', required: true, description: '下拉框的 ref（dsh-ref-N）或 CSS 选择器' },
      value: { type: 'string', required: true, description: '要选的选项值，或选项显示的文字' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error + (v.options && v.options.length ? '\n可选项: ' + v.options.join(' / ') : '');
      return '已选中「' + (v.label || v.picked) + '」';
    }),
    async execute(args) { return dispatch({ action: 'select', ref: args.ref, value: args.value }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_check',
    description: '勾选或取消复选框、单选框。状态本来就对时不重复操作。单选框天然无法通过点击取消，要清空请选同组的另一个。',
    parameters: {
      ref: { type: 'string', required: true, description: '复选框或单选框的 ref（dsh-ref-N）或 CSS 选择器' },
      checked: { type: 'boolean', description: '要设成的状态，默认 true（勾上）' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      return (v.checked ? '已勾上' : '已取消') + (v.already ? '（本来就是该状态，未再操作）' : '');
    }),
    async execute(args) { return dispatch({ action: 'check', ref: args.ref, checked: args.checked !== false }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_scroll',
    description: '滚动右推栏浏览器页面：滚到顶部、底部、按像素上下、或滚到某个元素。',
    parameters: {
      to: { type: 'string', description: 'top（到顶）、bottom（到底）、up、down；不给则按 amount 向下' },
      amount: { type: 'number', description: '滚动像素数，默认 600；to 为 up 时自动取负' },
      ref: { type: 'string', description: '要滚到的元素 ref 或选择器；给了这个就忽略 to' },
    },
    output: textOut((v) => v && v.error ? '失败: ' + v.error : '已滚动（当前纵向位置 ' + (v.y || 0) + ' 像素）'),
    async execute(args) {
      const to = args.to || '';
      const raw = typeof args.amount === 'number' ? args.amount : 600;
      return dispatch({ action: 'scroll', to, amount: to === 'up' ? -Math.abs(raw) : raw, ref: args.ref || '' });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_nav',
    description: '右推栏浏览器的前进、后退、刷新。',
    parameters: { how: { type: 'string', required: true, description: 'back（后退）、forward（前进）、reload（刷新）' } },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      const word = { back: '已后退', forward: '已前进', reload: '已刷新' };
      return (word[v.how] || '已执行') + (v.via ? '（' + v.via + '）' : '');
    }),
    async execute(args) { return dispatch({ action: 'history', how: args.how }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_eval',
    description: '在右推栏浏览器页面里执行一段 JavaScript 并把返回值带回来。做具体工具没覆盖的事时用；页面里的副作用由脚本自己承担，别拿它做破坏性操作。',
    parameters: { script: { type: 'string', required: true, description: '要执行的脚本，最后求值的结果会被带回' } },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      let body;
      try { body = typeof v.result === 'string' ? v.result : JSON.stringify(v.result); } catch { body = String(v.result); }
      return '执行结果: ' + (body || '(无返回值)').slice(0, 4000);
    }),
    async execute(args) { return dispatch({ action: 'eval', script: args.script }, 40000); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_info',
    description: '报告右推栏浏览器当前页面状况：地址、标题、加载状态、滚动位置、整页高度、视口高度。判断页面有没有加载完、是不是还在原地时用它。',
    parameters: {},
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      return [
        '地址: ' + v.url,
        '标题: ' + v.title,
        '加载状态: ' + v.ready,
        '滚动位置: ' + v.scrollY + ' / 整页高 ' + v.pageHeight + '，视口高 ' + v.viewportHeight,
      ].join('\n');
    }),
    async execute() { return dispatch({ action: 'info' }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_tabs',
    description: '管理右推栏的标签页：列出全部标签、切换到某个、关闭某个。',
    parameters: {
      how: { type: 'string', required: true, description: 'list（列出）、switch（切换）、close（关闭）' },
      tabId: { type: 'string', description: 'switch 和 close 时要指定哪个标签，先 list 拿到 tabId' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v.tabs) {
        if (v.count === 0) return '当前没有标签页';
        return '共 ' + v.count + ' 个标签页:\n' + v.tabs.map((t, i) => (i + 1) + '. ' + (t.kind || '未知') + '  ' + t.tabId + (t.title ? '  「' + t.title + '」' : '')).join('\n');
      }
      return (v.via === 'actions.closeTab' ? '已关闭标签 ' : '已切换到标签 ') + v.tabId;
    }),
    async execute(args) { return dispatch({ action: 'tabs', how: args.how, tabId: args.tabId || '' }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_zoom',
    description: '缩放右推栏浏览器里的网页内容。这是浏览器内核级缩放，文字和图片按比例一起变，不是改字号。右推栏窄的时候把页面缩到 0.7 左右，能在一栏里看到接近完整的宽版布局。只影响网页本身，不动 DSH 界面。',
    parameters: { factor: { type: 'number', description: '缩放倍数，1 为原始大小，0.7 表示缩到七成，范围 0.25 到 5；不填则读取当前倍数' } },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      const pct = Math.round((v.factor || 1) * 100);
      return '当前页面缩放 ' + pct + '%';
    }),
    async execute(args) {
      const f = typeof args.factor === 'number' ? args.factor : 'get';
      return dispatch({ action: 'zoom', factor: f });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_resize',
    description: '调节右推栏里网页框的大小。spec 传 handle 会在网页框右下角放一个拖动把手，左右拖动都能实时改宽度；传像素数直接设宽；传 phone(375)/narrow(480)/wide(720)/wider(960) 快速切换；传 reset 恢复默认。可传 240 到 4000，但生效上限是容器当前可用宽度，超出会被夹紧——返回值的 width 是实际生效值、asked 是请求值，两者不一致即被夹。改动不持久，刷新或重启后回到官方默认。',
    parameters: { spec: { type: 'string', required: true, description: 'handle（放拖动把手，之后左右拖动都能改宽度）、reset（恢复默认）、档位名（phone/narrow/wide/wider）、或 240 到 4000 的像素数。注意 4000 是可传上限不是生效上限：生效值会被夹到容器当前可用宽度，超出时返回值的 width 小于 asked' } },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v && v.note && v.alreadyHad) return v.note;
      if (v && v.note) return v.note + '；当前宽 ' + (v.width || '?') + ' 像素';
      return '网页框宽度已设为 ' + (v.width || '?') + ' 像素'
        + (v.asked && v.asked !== v.width ? '（实际生效 ' + v.width + '，超出容器可用宽度已夹紧——这是本插件自设的上限，防止把手飞出视口抓不到）' : '');
    }),
    async execute(args) {
      return dispatch({ action: 'resize', spec: args.spec });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_find',
    description: '在右推栏浏览器当前页面里查找文字，等同浏览器的查找功能：会高亮命中项并滚到第一处。',
    parameters: {
      text: { type: 'string', required: true, description: '要查找的文字' },
      forward: { type: 'boolean', description: '是否向后找，默认 true' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (typeof v.matches === 'number') return '找到 ' + v.matches + ' 处' + (v.active ? '，当前停在第 ' + v.active + ' 处' : '');
      return v.note || '已发出查找请求';
    }),
    async execute(args) { return dispatch({ action: 'find', text: args.text, forward: args.forward !== false }, 20000); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_pdf',
    description: '把右推栏浏览器的当前页面导出成 PDF 存到本机，返回文件路径。适合把网页正文留下来慢慢看，或做一份能离线打开的存档。',
    parameters: {},
    output: textOut((v) => v && v.error ? '失败: ' + v.error : '已导出 PDF: ' + v.path + (v.bytes ? '（' + Math.round(v.bytes / 1024) + ' KB）' : '')),
    async execute() { return dispatch({ action: 'pdf' }, 60000); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_history',
    description: '查以前在右推栏打开过哪些网页。历史存在本机，跨会话、重启都不丢，可以按网址或标题里的词筛选。',
    parameters: {
      query: { type: 'string', description: '筛选词，匹配网址或标题；不填则列出最近的' },
      limit: { type: 'number', description: '返回条数，默认 30' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (!v.entries || v.entries.length === 0) {
        const d = v.diag || {};
        const why = d.error ? '读取出错: ' + d.error
          : d.exists === false ? '记录文件还不存在: ' + d.file
            : '记录文件在，但里面是空的: ' + d.file;
        return (v.query ? '没有匹配「' + v.query + '」的记录。' : '还没有访问记录。') + '（' + why + '）';
      }
      const lines = v.entries.map((e, i) => {
        const when = (e.at || '').replace('T', ' ').slice(0, 16);
        return (i + 1) + '. ' + when + '  ' + e.url;
      });
      return '共 ' + v.entries.length + ' 条' + (v.query ? '（筛选「' + v.query + '」）' : '') + ':\n' + lines.join('\n');
    }),
    async execute(args) {
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 30;
      const got = readHistory(limit * 4);
      let entries = got.entries;
      const q = (args.query || '').trim().toLowerCase();
      if (q !== '') entries = entries.filter((e) => (e.url || '').toLowerCase().includes(q) || (e.title || '').toLowerCase().includes(q));
      return { ok: true, entries: entries.slice(0, limit), query: q, count: Math.min(entries.length, limit), diag: got.diag };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_style',
    description: '往右推栏浏览器的当前页面注入一段 CSS，用来放大字号、隐藏遮挡内容的浮层、换深色底。刷新页面即恢复原样。给 key 则是撤销之前注入的那一段。',
    parameters: {
      css: { type: 'string', description: '要注入的 CSS 文本；撤销时不用填' },
      key: { type: 'string', description: '要撤销的样式标识，由上一次注入返回' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v.removed) return '已撤销样式 ' + v.removed;
      return '已注入样式，标识 ' + v.key + '（刷新页面即失效）';
    }),
    async execute(args) { return dispatch({ action: 'style', css: args.css || '', key: args.key || '' }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_health',
    description: '查右推栏浏览器页面的健康状况：是否崩溃、是否还在加载、是否静音、是否正在出声。how 给 mute 则切换静音。',
    parameters: {
      how: { type: 'string', description: 'status（默认，查看状况）或 mute（切换静音）' },
      muted: { type: 'boolean', description: 'mute 时是否静音，默认 true' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (typeof v.muted === 'boolean' && v.crashed === undefined) return v.muted ? '已静音' : '已取消静音';
      const bits = [];
      bits.push('崩溃: ' + (v.crashed ? '是' : '否'));
      bits.push('加载中: ' + (v.loading ? '是' : '否'));
      bits.push('静音: ' + (v.muted ? '是' : '否'));
      bits.push('出声: ' + (v.audible ? '是' : '否'));
      bits.push('标题: ' + (v.title || '(无)'));
      return bits.join('\n');
    }),
    async execute(args) { return dispatch({ action: 'health', how: args.how || 'status', muted: args.muted !== false }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_key',
    description: '往右推栏浏览器的页面里按键：Enter、Tab、Escape、方向键、PageDown、F1-F12、Ctrl+A 这类组合都行。桌面版是 Electron 原生按键，Tab 移焦与 Enter 提交都会真实发生。可先用 rightbar_controls 拿到 ref，指定在哪个控件上按。',
    parameters: {
      key: { type: 'string', required: true, description: '按键，例如 Enter、Tab、Escape、ArrowDown、Ctrl+A' },
      ref: { type: 'string', description: '先聚焦到这个控件再按键，来自 rightbar_controls 或 rightbar_read' },
      times: { type: 'number', description: '连续按几次，默认 1' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      const n = v.times && v.times > 1 ? ' ' + v.times + ' 次' : '';
      return '已按 ' + v.key + n + '（' + (v.via === 'webview.sendInputEvent' ? '真实按键' : v.via) + '）' + (v.note ? '\n' + v.note : '');
    }),
    async execute(args) { return dispatch({ action: 'key', key: args.key, ref: args.ref || '', times: args.times }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_controls',
    description: '列出右推栏浏览器页面上的全部表单控件：输入框、下拉框、勾选框、富文本框，带当前值、标签、是否禁用或只读。用来确认内容填进去了没有，也用来拿 ref 供 rightbar_fill、rightbar_select、rightbar_check、rightbar_key 使用。',
    parameters: {},
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (!v.controls || v.controls.length === 0) return '当前页面上没有可填写的控件';
      const lines = v.controls.map((c, i) => {
        const bits = [(i + 1) + '. ' + c.type + '  ' + c.ref + (c.label ? '  「' + c.label + '」' : '')];
        if (c.checked !== undefined) bits.push(c.checked ? '已勾选' : '未勾选');
        else if (c.value !== undefined) bits.push(c.value === '' ? '(空)' : '值: ' + c.value.replace(/\n/g, ' '));
        if (c.disabled) bits.push('禁用');
        if (c.readonly) bits.push('只读');
        if (c.required) bits.push('必填');
        if (c.options && c.options.length > 0) bits.push('选项: ' + c.options.join(' / '));
        return bits.join('  ');
      });
      return '共 ' + v.count + ' 个控件:\n' + lines.join('\n');
    }),
    async execute() { return dispatch({ action: 'controls' }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_captcha',
    description: '探测右推栏浏览器当前页面有没有验证码，是滑块、图形码、点选还是第三方验证框架（极验、reCAPTCHA 等），给出位置与 ref。只负责找到并说明，不替你决定怎么过；看不清就配合 rightbar_shot 截图。',
    parameters: {},
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      const hints = v.textHints && v.textHints.length ? v.textHints.join('；') : '';
      if (!v.found) return '当前页面没有探测到验证码' + (hints ? '（页面上出现了这些字：' + hints + '，可再截图确认）' : '');
      const lines = v.hits.map((h, i) => (i + 1) + '. ' + h.kind + '  ' + h.ref + (h.hint ? '  ' + h.hint : '') + '  位置 ' + h.box.x + ',' + h.box.y + ' 大小 ' + h.box.w + 'x' + h.box.h);
      return '探测到 ' + v.count + ' 处疑似验证码:\n' + lines.join('\n') + (hints ? '\n页面文字线索: ' + hints : '');
    }),
    async execute() { return dispatch({ action: 'captcha' }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_a11y',
    description: '读右推栏浏览器当前页面的无障碍树：按语义角色（链接、按钮、输入框、标题、列表等）列出名称与状态，可操作节点带 ref。比 rightbar_read 省上下文，适合结构复杂或文字很多的页面。这是从页面语义推导的，canvas 自绘界面仍然要靠截图。',
    parameters: {},
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (!v.nodes || v.nodes.length === 0) return '页面上没有可识别的语义节点';
      const lines = v.nodes.map((n) => {
        const pad = '  '.repeat(n.depth);
        const bits = [pad + n.role + (n.name ? ' 「' + n.name + '」' : '') + (n.ref ? '  [' + n.ref + ']' : '')];
        if (n.level) bits.push('h' + n.level);
        if (n.value) bits.push('值: ' + String(n.value).replace(/\n/g, ' '));
        if (n.checked !== undefined) bits.push(n.checked ? '已勾选' : '未勾选');
        if (n.disabled) bits.push('禁用');
        if (n.expanded !== undefined) bits.push(n.expanded ? '已展开' : '已收起');
        return bits.join('  ');
      });
      return v.title + '\n' + lines.join('\n');
    }),
    async execute() { return dispatch({ action: 'a11y' }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_shot_full',
    description: '把右推栏浏览器当前页面整页截图：从页顶一直截到底，存成一张图返回路径。长页面会自动分段拍摄再拼接，页头固定栏可能在拼接处重复出现。桌面版可用。',
    parameters: { maxHeight: { type: 'number', description: '最高截多少像素，默认 20000，防止超长页面耗尽内存' } },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      const kb = v.bytes ? Math.round(v.bytes / 1024) + ' KB' : '大小未知';
      return '已保存整页截图: ' + v.path + '（' + (v.pages || 1) + ' 屏，' + kb + (v.truncated ? '，超出部分已截断' : '') + '）';
    }),
    async execute(args) {
      const max = typeof args.maxHeight === 'number' && args.maxHeight > 0 ? Math.min(args.maxHeight, 60000) : 20000;
      return dispatch({ action: 'shotfull', maxHeight: max }, 180000);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_scrape',
    description: '结构化提取：给列表项的 CSS 选择器，再给字段映射，一次把整块列表整理成 JSON。字段选择器支持 "css" 取文字、"css@href" 取属性、"" 取整项文字。适合把搜索结果、商品列表、表格行整理成结构化数据。',
    parameters: {
      item: { type: 'string', required: true, description: '每个条目的选择器，例如 .result-item 或 table tr' },
      fields: { type: 'object', required: true, additionalProperties: true, description: '字段映射，例如 {"标题": ".title", "链接": "a@href"}' },
      limit: { type: 'number', description: '最多提取多少条，默认 50' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v.empty) return v.empty;
      return '共提取 ' + v.count + ' 条:\n' + JSON.stringify(v.rows, null, 2);
    }),
    async execute(args) {
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 50;
      return dispatch({ action: 'scrape', item: args.item, fields: args.fields, limit }, 45000);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_download',
    description: '下载文件到本机。可以给网址，也可以给页面上某个链接的 ref。优先用页面自己的登录态取文件并落到 DSH_HOME/rightbar-downloads，成功返回文件路径；被跨域限制拦住时退回浏览器原生下载，文件进系统下载目录。',
    parameters: {
      url: { type: 'string', description: '文件网址；和 ref 二选一' },
      ref: { type: 'string', description: '页面上带下载链接的元素 ref，来自 rightbar_read 或 rightbar_controls' },
      name: { type: 'string', description: '保存的文件名，不填则按网址最后一段' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v.path) return '已下载: ' + v.path + (v.bytes ? '（' + Math.round(v.bytes / 1024) + ' KB）' : '');
      return '已交给浏览器原生下载' + (v.note ? '：' + v.note : '');
    }),
    async execute(args) { return dispatch({ action: 'download', url: args.url || '', ref: args.ref || '', name: args.name || '' }, 120000); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_ops',
    description: '查右推栏的操作记录：每一步做了什么、成没成功、耗时多少。排查「刚才那个点击到底发生没有」时用。',
    parameters: {
      limit: { type: 'number', description: '返回条数，默认 30' },
      action: { type: 'string', description: '只看某一种动作，例如 click、fill、open' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (!v.entries || v.entries.length === 0) return '还没有操作记录';
      const lines = v.entries.map((e, i) => {
        const when = (e.at || '').replace('T', ' ').slice(5, 19);
        const state = e.blocked ? '被白名单拦截' : e.ok ? '成功' : '失败';
        const err = e.error ? '  ' + e.error : '';
        return (i + 1) + '. #' + (e.seq === undefined ? '?' : e.seq) + '  ' + when + '  ' + (ACTION_TOOL[e.action] || e.action) + '  ' + state + (e.ms ? '  ' + e.ms + 'ms' : '') + err;
      });
      return '共 ' + v.count + ' 条:\n' + lines.join('\n');
    }),
    async execute(args) {
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 30;
      let entries = readOps(limit * 4);
      if (args.action) entries = entries.filter((e) => e.action === args.action);
      entries = entries.slice(0, limit);
      return { ok: true, entries, count: entries.length };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_replay',
    description: '重放操作。默认只列计划不动手；confirm 为 true 才真的执行。可以给 seq 精确重放某一步，也可以给 from 与 to 重放一段，或者用 last 重放最近若干步。只重放会改变页面状态的动作（打开、导航、点击、坐标点击、填写、设值、输入文字、选择、勾选、按键、滚动、等待），观察类动作跳过；参数被截断的记录也会跳过并说明。',
    parameters: {
      seq: { type: 'number', description: '精确重放的操作序号，来自 rightbar_ops' },
      from: { type: 'number', description: '重放区间的起始序号（含）' },
      to: { type: 'number', description: '重放区间的结束序号（含）' },
      last: { type: 'number', description: '重放最近几条可重放动作，默认 5；给了 seq 或区间时忽略' },
      confirm: { type: 'boolean', description: '为 true 才真的执行，默认只返回计划' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v.dryRun) {
        if (!v.plan || v.plan.length === 0) return '没有可重放的动作';
        return '准备重放 ' + v.plan.length + ' 步（还没执行，确认后加 confirm=true）:\n'
          + v.plan.map((p, i) => (i + 1) + '. 第 ' + (p.seq === undefined ? '?' : p.seq) + ' 步  ' + (ACTION_TOOL[p.action] || p.action) + '  ' + JSON.stringify(p.args)).join('\n');
      }
      const okCount = v.results.filter((r) => r.ok).length;
      return '重放完成 ' + okCount + '/' + v.results.length + ' 步成功:\n'
        + v.results.map((r, i) => (i + 1) + '. 第 ' + (r.seq === undefined ? '?' : r.seq) + ' 步  ' + (ACTION_TOOL[r.action] || r.action) + '  ' + (r.ok ? '成功' : '失败: ' + r.error)).join('\n');
    }),
    async execute(args) {
      const REPLAYABLE = new Set(['open', 'navigate', 'click', 'clickat', 'fill', 'setvalue', 'type', 'select', 'check', 'key', 'scroll', 'wait']);
      const all = readOps(2000).filter((e) => REPLAYABLE.has(e.action) && e.blocked !== true).reverse();
      let picked;
      if (typeof args.seq === 'number') {
        picked = all.filter((e) => e.seq === args.seq);
        if (picked.length === 0) return { error: '没有找到第 ' + args.seq + ' 步可重放的动作（它可能不是改变类动作）' };
      } else if (typeof args.from === 'number' || typeof args.to === 'number') {
        const from = typeof args.from === 'number' ? args.from : -Infinity;
        const to = typeof args.to === 'number' ? args.to : Infinity;
        picked = all.filter((e) => Number(e.seq) >= from && Number(e.seq) <= to);
        if (picked.length === 0) return { error: '这个区间里没有可重放的动作' };
      } else {
        const last = typeof args.last === 'number' && args.last > 0 ? Math.min(args.last, 50) : 5;
        picked = all.slice(-last);
      }
      const plan = [];
      const skipped = [];
      for (const op of picked) {
        const truncated = Object.values(op.args || {}).some((v) => typeof v === 'string' && v.endsWith('…'));
        if (truncated) skipped.push({ seq: op.seq, action: op.action, why: '参数被截断' });
        else plan.push({ seq: op.seq, action: op.action, args: op.args || {} });
      }
      if (args.confirm !== true) return { ok: true, dryRun: true, plan, skipped };
      const results = [];
      for (const step of plan) {
        const v = await dispatch({ action: step.action, ...step.args }, 30000);
        results.push({ seq: step.seq, action: step.action, ok: !(v && v.error), error: v && v.error });
      }
      return { ok: true, dryRun: false, results, skipped, count: results.length };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_restrict',
    description: '设置动作白名单，防止在只读任务里被误点、误提交。readonly 只允许观察类动作；custom 按 allow 列表放行；off 关闭限制。这是软护栏，不是安全边界。',
    parameters: {
      mode: { type: 'string', required: true, description: 'readonly（只读）、custom（自定义）、off（关闭）' },
      allow: { type: 'array', description: 'custom 模式允许的动作名，例如 ["open","read","click"]', items: { type: 'string' } },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v.policy.mode === 'off') return '动作白名单已关闭';
      if (v.policy.mode === 'readonly') return '已切到只读模式：只允许观察类动作（打开、导航、读取、截图、查找、缩放等）';
      return '已启用自定义白名单: ' + (v.policy.allow.join('、') || '(空，等于全部禁止)');
    }),
    async execute(args) {
      const raw = String(args.mode || '').toLowerCase();
      if (raw !== 'readonly' && raw !== 'custom' && raw !== 'off') {
        return { error: 'mode 只能是 readonly、custom 或 off' };
      }
      const allow = Array.isArray(args.allow) ? args.allow.map(String).filter((s) => s !== '') : [];
      if (raw === 'custom' && allow.length === 0) return { error: 'custom 模式要给出 allow 列表' };
      const policy = { mode: raw, allow };
      writePolicy(policy);
      return { ok: true, policy };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_type',
    description: '往右推栏浏览器的页面里整段输入文字，像人一样逐字打进去。桌面版走 webview 原生 insertText，中文、符号都能输入；先给 ref 会先聚焦到那个输入框。适合被脚本严密接管的输入框，或者填完还需要触发输入法事件的场景。',
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文字' },
      ref: { type: 'string', description: '先聚焦到这个输入框，来自 rightbar_controls 或 rightbar_read' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      return '已输入 ' + (v.chars || 0) + ' 个字（' + (v.via || 'ok') + '）';
    }),
    async execute(args) { return dispatch({ action: 'type', text: args.text, ref: args.ref || '' }, 45000); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_set_value',
    description: '直接给控件设值，或者清空。定位方式三选一：ref、CSS 选择器、或者标签文字。写值走原生 setter 再派发 input 与 change，React 这类框架也认。clear 为 true 时清空输入框或取消勾选。',
    parameters: {
      value: { type: 'string', description: '要写入的值；清空时不必填' },
      ref: { type: 'string', description: '控件 ref，来自 rightbar_controls' },
      selector: { type: 'string', description: 'CSS 选择器，例如 #user 或 input[name=q]' },
      text: { type: 'string', description: '按标签或占位文字找控件，例如 用户名' },
      clear: { type: 'boolean', description: '为 true 则清空输入框或取消勾选' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v.cleared) return '已清空';
      return '已设值: ' + (v.value === undefined ? '' : v.value);
    }),
    async execute(args) {
      return dispatch({
        action: 'setvalue',
        value: args.value === undefined ? '' : args.value,
        ref: args.ref || '',
        selector: args.selector || '',
        text: args.text || '',
        clear: args.clear === true,
      });
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_cookies',
    description: '读或写当前页面的 Cookie。flush 把当前站点的 Cookie 存到本机，restore 把存档灌回页面，list 列出存了哪些站点。只包含页面脚本能读到的 Cookie，HttpOnly 的那些浏览器不给读，存不了。',
    parameters: {
      how: { type: 'string', required: true, description: 'flush（存）、restore（灌回）、list（列出存档）' },
      name: { type: 'string', description: '存档名；flush 不填则按站点域名存，restore 必须指定' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v.entries) {
        if (v.entries.length === 0) return '还没有 Cookie 存档';
        return '共 ' + v.entries.length + ' 份存档:\n' + v.entries.map((e, i) => (i + 1) + '. ' + e.name + '  ' + e.count + ' 条  ' + e.host + '  ' + (e.at || '').replace('T', ' ').slice(0, 16)).join('\n');
      }
      if (v.set !== undefined) return '已把 ' + v.set + ' 条 Cookie 灌回页面' + (v.note ? '\n' + v.note : '');
      return '已存下 ' + (v.count || 0) + ' 条 Cookie，存档名 ' + v.name + (v.note ? '\n' + v.note : '');
    }),
    async execute(args) {
      const how = String(args.how || '');
      if (how === 'list') {
        const store = readCookieStore();
        const entries = Object.keys(store).map((key) => ({ name: key, host: store[key].host || '', count: (store[key].cookies || []).length, at: store[key].at || '' }));
        return { ok: true, entries };
      }
      if (how === 'flush') {
        const got = await dispatch({ action: 'cookies', how: 'get' });
        if (got && got.error) return got;
        const host = (() => { try { return new URL(got.url).host; } catch { return 'unknown'; } })();
        const name = args.name || host;
        const store = readCookieStore();
        store[name] = { host, url: got.url, at: new Date().toISOString(), cookies: got.cookies || [] };
        writeCookieStore(store);
        return { ok: true, name, count: (got.cookies || []).length, note: 'HttpOnly 的 Cookie 读不到，没有存进去。' };
      }
      if (how === 'restore') {
        if (!args.name) return { error: 'restore 要指定存档名，先 list 看有哪些' };
        const store = readCookieStore();
        const entry = store[args.name];
        if (!entry) return { error: '没有找到存档 ' + args.name };
        const got = await dispatch({ action: 'cookies', how: 'set', cookies: entry.cookies || [] });
        if (got && got.error) return got;
        return { ok: true, set: got.set || 0, note: '页面要刷新一次才会用上新 Cookie。' };
      }
      return { error: 'how 只能是 flush、restore 或 list' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_session_reset',
    description: '重建浏览器会话：把右推栏里的浏览器标签全部关掉，再开一个新的。页面卡死、崩溃、或者状态被弄脏时用它收场，不影响别的插件与别的标签类型。',
    parameters: { url: { type: 'string', description: '重建后打开的网址，不填则空白页' } },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      return '已重建会话，关掉 ' + (v.closed || 0) + ' 个旧标签，新标签' + (v.frames ? '已上屏（框架 ' + v.frames + ' 个）' : '已请求打开');
    }),
    async execute(args) { return dispatch({ action: 'sessionreset', url: args.url || '' }, 60000); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_content',
    description: '把右推栏浏览器当前页面的内容导出。markdown 适合留档与阅读，html 是去掉脚本样式的正文结构，text 是纯文字，json 给出标题、大纲与链接清单。适合长文与资料整理，比 rightbar_read 省上下文。',
    parameters: {
      format: { type: 'string', description: 'markdown（默认）、html、text、json' },
      maxChars: { type: 'number', description: '最多返回多少字符，默认 20000' },
    },
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      if (v.format === 'json') {
        const head = (v.headings || []).map((h) => '  '.repeat(Math.max(0, h.level - 1)) + 'h' + h.level + ' ' + h.text).join('\n');
        return '标题: ' + (v.title || '') + '\n大纲:\n' + head + '\n链接 ' + (v.links || []).length + ' 个';
      }
      return (v.truncated ? '（内容过长已截断）\n' : '') + (v.content || '');
    }),
    async execute(args) {
      const format = ['markdown', 'html', 'text', 'json'].indexOf(String(args.format)) >= 0 ? String(args.format) : 'markdown';
      const maxChars = typeof args.maxChars === 'number' && args.maxChars > 0 ? Math.min(args.maxChars, 200000) : 20000;
      return dispatch({ action: 'content', format, maxChars }, 45000);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_search_status',
    description: '查联网搜索现在走哪条路：自建搜索端口通不通、隧道起没起、有没有配 Tavily 密钥、浏览器兜底开没开。搜索异常时先看这个，它会顺手把隧道拉起来。',
    parameters: {},
    output: textOut((v) => {
      if (v && v.error) return '失败: ' + v.error;
      const lines = [];
      lines.push('自建搜索 ' + v.searxng.url + '：' + (v.searxng.open ? '端口通' : '端口不通'));
      if (v.searxng.results >= 0) lines.push('试查返回 ' + v.searxng.results + ' 条');
      if (v.searxng.error) lines.push('试查错误：' + v.searxng.error);
      lines.push('Tavily：' + (v.tavily ? '已配置密钥' : '没有密钥（不影响，前两层够了）'));
      lines.push('浏览器兜底：' + (v.browserFallback ? '已开启' : '已关闭'));
      lines.push('配置文件：' + v.configFile);
      return lines.join('\n');
    }),
    async execute() {
      const cfg = readSearchConfig();
      let port = 0;
      try { port = Number(new URL(cfg.searxng.url).port || 80); } catch { port = 0; }
      const open = port > 0 ? await portOpen(port) : false;
      let results = -1;
      let error;
      if (port > 0) {
        try {
          const found = await searxngSearch(cfg, { query: 'ping', maxResults: 1 }, null);
          results = found.sources.length;
        } catch (e) { error = String((e && e.message) || e); }
      }
      return {
        ok: true,
        searxng: { url: cfg.searxng.url, port, open, results, error },
        tavily: cfg.tavilyKey !== '',
        browserFallback: cfg.browserFallback !== false,
        configFile: SEARCH_CONFIG_FILE,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_close',
    description: '关闭右推栏内置浏览器的标签页。',
    parameters: {},
    output: textOut((v) => '已请求关闭右推栏浏览器标签页' + (v && v.note ? '；' + v.note : '')),
    async execute() { return dispatch({ action: 'close' }); },
  }));

  if (ctx.web !== undefined && typeof ctx.web.registerSearchProvider === 'function') {
    try {
      ctx.web.registerSearchProvider(new MoonSearchProvider(dispatch));
      SEARCH_PROVIDER_STATE.registered = true;
      console.log('[rightbar-driver] search provider registered');
    } catch (e) {
      SEARCH_PROVIDER_STATE.error = String((e && e.message) || e);
      console.log('[rightbar-driver] search provider registration failed', SEARCH_PROVIDER_STATE.error);
    }
  } else {
    SEARCH_PROVIDER_STATE.error = 'ctx.web.registerSearchProvider 不可用';
  }

  // 多元抓取：注册带镜像兜底的抓取提供方。
  // 注意：注册第二个抓取提供方会让官方出现「多个可用提供方」，
  // 需要在 profile 的 cordis.patch.yml 里把 dsh-web 的 fetchProvider 固定成
  // moon-fetch，否则 web_fetch 会报 WEB_PROVIDER_AMBIGUOUS。
  if (ctx.web !== undefined && typeof ctx.web.registerFetchProvider === 'function') {
    try {
      ctx.web.registerFetchProvider(new MoonFetchProvider());
      FETCH_STATE.registered = true;
      console.log('[rightbar-driver] fetch provider registered');
    } catch (e) {
      FETCH_STATE.lastError = String((e && e.message) || e);
      console.log('[rightbar-driver] fetch provider registration failed', FETCH_STATE.lastError);
    }
  } else {
    FETCH_STATE.lastError = 'ctx.web.registerFetchProvider 不可用';
  }

  // 自测口：走 DSH 自己的搜索入口，验证提供方选择与三层回退是不是真的通。
  if (ctx.web !== undefined && typeof ctx.web.search === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/rightbar-api/search-test',
      handler: async (req, res) => {
        let query = 'test';
        try { query = new URL(req.url, 'http://127.0.0.1').searchParams.get('q') || query; } catch { /* 用默认词 */ }
        try {
          const result = await ctx.web.search({ query, maxResults: 3 }, AbortSignal.timeout(25000));
          sendJson(res, 200, { ok: true, query, sources: result.sources, truncated: result.truncated, provider: SEARCH_PROVIDER_STATE });
        } catch (e) {
          sendJson(res, 200, { ok: false, query, error: String((e && e.message) || e), provider: SEARCH_PROVIDER_STATE });
        }
      },
    }));
  }

  // 自测口：走 DSH 自己的抓取入口，验证镜像兜底是不是真的生效。
  if (ctx.web !== undefined && typeof ctx.web.fetch === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/rightbar-api/fetch-test',
      handler: async (req, res) => {
        let target = '';
        try { target = new URL(req.url, 'http://127.0.0.1').searchParams.get('u') || ''; } catch { /* 下面会报空地址 */ }
        try {
          const got = await ctx.web.fetch({ url: target }, AbortSignal.timeout(30000));
          sendJson(res, 200, {
            ok: true,
            requested: target,
            finalUrl: got.url,
            statusCode: got.statusCode,
            kind: got.body && got.body.kind,
            chars: got.body && got.body.content ? got.body.content.length : 0,
            head: got.body && got.body.content ? got.body.content.slice(0, 300) : '',
            truncated: got.truncated,
            state: FETCH_STATE,
          });
        } catch (e) {
          sendJson(res, 200, { ok: false, requested: target, error: String((e && e.message) || e), state: FETCH_STATE });
        }
      },
    }));
  }

  ctx.systemPrompt.section({
    name: 'rightbar-driver',
    order: -997,
    text: () => '右推栏内置浏览器驱动（rightbar_* 工具）。打开与导航：rightbar_open 在右推栏打开官方内置浏览器并可带网址；rightbar_navigate 导航；rightbar_nav 前进后退刷新；rightbar_history 查以前打开过哪些网页（跨会话可查）；rightbar_tabs 列出、切换、关闭标签页。观察：rightbar_read 读页面文本与可交互元素（ref 同一次 read 内有效，页面变化后重新 read）；rightbar_a11y 读无障碍树，语义角色+名称+状态，更省上下文；rightbar_controls 列表单控件的当前值与 ref；rightbar_captcha 探测验证码位置与类型；rightbar_info 报告地址、标题、加载状态、滚动位置；rightbar_shot 截图存盘并返回路径（桌面版可用，可用 read_image 查看）；rightbar_shot_full 整页截图，从顶到底一张图；rightbar_health 查崩溃、加载、静音状况。操作：rightbar_click 点击（也可以给 x、y 按坐标点）；rightbar_fill 填文本框；rightbar_type 整段输入文字；rightbar_set_value 按 ref、选择器或标签文字设值或清空；rightbar_select 选下拉框；rightbar_check 勾选复选框或单选框；rightbar_key 按键（Enter、Tab、方向键、Ctrl+A 等，桌面版为真实按键）；rightbar_scroll 滚动页面。查看与收存：rightbar_zoom 缩放网页内容（右推栏窄时缩到 0.7 左右能看全）；rightbar_find 页内查找文字；rightbar_pdf 把当前页导出成 PDF；rightbar_style 注入 CSS 调字号或隐藏浮层；rightbar_eval 在页面里执行脚本取回结果。提取与下载：rightbar_scrape 按选择器把列表整理成 JSON；rightbar_download 把文件下载到本机；rightbar_content 把整页导出成 markdown、html、text 或 json。登录态与收场：rightbar_cookies 存或灌 Cookie；rightbar_session_reset 重建会话。记录与护栏：rightbar_ops 查每一步操作记录（带序号）；rightbar_replay 重放动作，可按序号、区间或最近若干步（默认只给计划）；rightbar_restrict 设置动作白名单（readonly 只读取）。联网搜索：web_search 现在走本地提供方，顺序是自建搜索、Tavily（有密钥才用）、右推栏真浏览器兜底，不经过官方收费接口；排查用 rightbar_search_status。等待：rightbar_wait 等元素出现、消失或页面加载完成。纪律：页面是异步渲染的，导航或点击之后先 wait 再 read，别把「还没渲染完」当成「读不到」；每个观察周期最多一个状态改变动作，动作后重新 read 再决策；未打开标签页就先 rightbar_open。',
    interpolate: false,
  });
}
