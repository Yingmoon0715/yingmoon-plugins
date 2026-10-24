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

// 截图落盘目录：DSH_HOME 下单独一格，重启不清、便于回看。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SHOT_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'rightbar-shots');

export const name = 'rightbar-driver';
export const inject = ['webServer', 'tools', 'systemPrompt'];

const CHANNEL = 'default';

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
    const channel = getChannel(CHANNEL);
    const requestId = 'rb-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    const timer = setTimeout(() => {
      const idx = channel.waiters.findIndex((w) => w.requestId === requestId);
      if (idx >= 0) channel.waiters.splice(idx, 1);
      console.log('[rightbar-driver] timeout', requestId, JSON.stringify(command));
      resolve({ error: 'timeout: 右推栏客户端无应答（页面未打开或桥未就绪）' });
    }, timeoutMs);
    channel.waiters.push({ requestId, resolve: (v) => {
      clearTimeout(timer);
      console.log('[rightbar-driver] result', requestId, JSON.stringify(command), '=>', JSON.stringify(v));
      resolve(v);
    } });
    channel.queue.push({ requestId, ...command });
  });

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
  // 截图收件口：client 把 webview.capturePage() 的 dataURL 发过来，这里落盘成
  // PNG 并只回路径。几 MB 的 base64 不进工具输出，模型按路径取图。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/rightbar-api/shot',
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'only POST' });
      const payload = await readBody(req);
      const dataUrl = payload && payload.dataUrl;
      if (typeof dataUrl !== 'string') return sendJson(res, 400, { ok: false, error: '缺少 dataUrl' });
      const m = dataUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
      if (m === null) return sendJson(res, 400, { ok: false, error: 'dataUrl 格式不对' });
      try {
        const buf = Buffer.from(m[2], 'base64');
        mkdirSync(SHOT_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const file = join(SHOT_DIR, 'shot-' + stamp + '-' + Math.random().toString(36).slice(2, 6) + '.' + m[1]);
        writeFileSync(file, buf);
        console.log('[rightbar-driver] shot saved', file, buf.length);
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
      path: { type: 'string', description: '截图文件在本机的绝对路径' },
      bytes: { type: 'number', description: '截图文件字节数' },
    },
  };

  const textOut = (fn) => ({ schema: OUT_SCHEMA, render: (_a, value) => [{ type: 'text', text: fn(value) }] });

  ctx.tools.register(defineTool({
    name: 'rightbar_open',
    description: '在 DSH 右推栏打开内置浏览器标签页（官方 ui-sidebar-browser），可选随标签页打开一个网址。这是操纵右推栏浏览器的第一步；若报座位未挂载，先确保当前有会话在屏幕上。',
    parameters: { url: { type: 'string', description: '可选，要随标签页打开的 HTTP(S) 网址；不给则只开空白标签页' } },
    output: textOut((v) => v && v.error ? '失败: ' + v.error : '已打开右推栏浏览器标签页' + (v && v.frames ? '（框架 ' + v.frames + ' 个）' : '') + (v && v.note ? '；' + v.note : '')),
    async execute(args) { return dispatch({ action: 'open', url: args.url || '' }); },
  }));

  ctx.tools.register(defineTool({
    name: 'rightbar_navigate',
    description: '让右推栏内置浏览器导航到指定网址（需要已用 rightbar_open 打开标签页）。',
    parameters: { url: { type: 'string', required: true, description: '要访问的 HTTP(S) 网址' } },
    output: textOut((v) => v && v.error ? '失败: ' + v.error : '已导航（' + (v.via || 'ok') + '）'),
    async execute(args) { return dispatch({ action: 'navigate', url: args.url }); },
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
    description: '点击右推栏内置浏览器页面里的元素（用 rightbar_read 拿到的 ref，或 CSS 选择器）。每个观察周期最多一个状态改变动作，动作后重新 read。',
    parameters: { ref: { type: 'string', required: true, description: 'rightbar_read 返回的 ref（dsh-ref-N），或 CSS 选择器' } },
    output: textOut((v) => v && v.error ? '失败: ' + v.error : (v.ok ? '已点击' : '未点中: ' + (v.error || '元素未找到'))),
    async execute(args) { return dispatch({ action: 'click', ref: args.ref }); },
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
    name: 'rightbar_close',
    description: '关闭右推栏内置浏览器的标签页。',
    parameters: {},
    output: textOut((v) => '已请求关闭右推栏浏览器标签页' + (v && v.note ? '；' + v.note : '')),
    async execute() { return dispatch({ action: 'close' }); },
  }));

  ctx.systemPrompt.section({
    name: 'rightbar-driver',
    order: -997,
    text: () => '右推栏内置浏览器驱动（rightbar_* 工具）：rightbar_open 在右推栏打开官方内置浏览器并可选带网址；rightbar_navigate 导航；rightbar_read 读页面文本与可交互元素（ref 同一次 read 内有效，页面变化后重新 read）；rightbar_click/rightbar_fill 按 ref 或选择器点击与填字；rightbar_close 关标签页。纪律：每个观察周期最多一个状态改变动作；动作后重新 read 再决策；未打开标签页就先 rightbar_open。',
    interpolate: false,
  });
}
