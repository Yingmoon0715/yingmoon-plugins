# rightbar-driver

Drive the built-in browser inside the DeepSeek Harness right sidebar.

## What it does

The DSH right sidebar ships a browser tab (Ctrl+T, the official `ui-sidebar-browser`).
It renders pages fine, but nothing could operate it from the agent side — you had to
click and type by hand.

This plugin makes that browser operable. 38 tools, grouped by what they do:

**Open and navigate**
- `rightbar_open` — open the sidebar browser tab, optionally with a URL
- `rightbar_navigate` — navigate to a URL
- `rightbar_nav` — back, forward, reload
- `rightbar_history` — what was opened before, persisted across sessions and restarts
- `rightbar_tabs` — list, switch, close tabs

**Observe**
- `rightbar_read` — page text plus interactive elements carrying `dsh-ref-N` handles
- `rightbar_a11y` — the accessibility tree: semantic roles, names, states. Cheaper on context
- `rightbar_controls` — form controls with their current values and refs
- `rightbar_captcha` — locate CAPTCHAs and say which kind
- `rightbar_info` — address, title, load state, scroll position
- `rightbar_shot` — screenshot to disk, returns the path
- `rightbar_shot_full` — full-page screenshot, top to bottom in one image
- `rightbar_health` — crash, loading, mute status

**Operate**
- `rightbar_click` — click by ref or selector, or by x/y coordinates
- `rightbar_fill` — type into an input
- `rightbar_type` — type text character by character
- `rightbar_set_value` — set or clear by ref, selector, or label text
- `rightbar_select` — pick from a dropdown
- `rightbar_check` — tick or untick checkboxes and radios
- `rightbar_key` — press keys (Enter, Tab, arrows, Ctrl+A — real key events on desktop)
- `rightbar_scroll` — scroll the page

**Frame size**
- `rightbar_resize` — resize the browser frame. `handle` drops a drag grip on the frame's
  bottom-right corner; a pixel width sets it directly; presets `phone`(375) / `narrow`(480) /
  `wide`(720) / `wider`(960) switch quickly; `reset` restores the official default. Narrow
  the frame and the page's responsive layout reflows to its mobile shape on its own.

**View and keep**
- `rightbar_zoom` — engine-level zoom, not font size
- `rightbar_find` — find text in the page
- `rightbar_pdf` — export the current page to PDF
- `rightbar_style` — inject CSS to change font size, hide overlays, go dark
- `rightbar_eval` — run a script in the page and bring back the result

**Extract and download**
- `rightbar_scrape` — pull a list into JSON by CSS selector
- `rightbar_download` — download a file to the host
- `rightbar_content` — export the whole page as markdown, html, text, or json

**Login state and teardown**
- `rightbar_cookies` — save or restore cookies
- `rightbar_session_reset` — rebuild the browser session
- `rightbar_close` — close the browser tab

**Record and guardrails**
- `rightbar_ops` — every operation with sequence, time, duration, outcome
- `rightbar_replay` — replay actions, by sequence, range, or last N
- `rightbar_restrict` — whitelist actions (readonly mode)
- `rightbar_search_status` — which route the built-in web search is taking right now

Opening and navigation go through the official public API
`ctx.sidebarRight.openTab('browser', { params: { url } })`. Reading and interaction
run inside the browser guest through the same channel the official desktop build
uses. No extra process, no second browser, no memory overhead, and nothing touches
the browser you are already logged into.

## Why it exists

Every other browser plugin on the market starts a *second* browser: a Playwright
Chromium, an Electron window, or a CDP connection to your own Chrome. That is the
right answer when you need isolation, downloads, or cookie persistence. It is the
wrong answer when the browser you want is already sitting in the sidebar and you
just want the agent to be able to use it.

## Requirements

- DSH desktop build. The sidebar browser renders as an Electron `<webview>` there,
  which is what makes page reading possible.
- A Session must be on screen. The official `sidebarRight.require()` throws
  "no session surface is mounted" otherwise — that is official behaviour, not a
  plugin limitation.
- On `dsh web` (no desktop shell) the sidebar browser renders as an `<iframe>`.
  Opening and navigation still work; reading and interaction cannot, because the
  browser same-origin policy forbids reading a cross-origin frame. The plugin
  reports that plainly instead of throwing an opaque error.

## Install

```
dsh plugin add github:Yingmoon0715/yingmoon-plugins#path:/plugins/rightbar-driver
```

Or from the plugin market inside DSH.

## It also replaces web search

DeepSeek's official web search becomes pay-per-call on 1 November 2026. This plugin
also registers itself as a DSH search provider (id `moon-local`), so `web_search`
runs on your own sources instead of the metered official one.

Three tiers, first success wins:

1. **Self-hosted SearXNG** (recommended): reached over an SSH tunnel the plugin
   opens on demand and reopens after a drop. Configuration lives in
   `DSH_HOME/search-sources.json`.
2. **Tavily**: only used when `tavilyKey` is set.
3. **Real browser fallback**: opens Sogou, 360, then Bing in the sidebar browser and
   scrapes real result links. Last resort — it does touch sidebar tabs.

All three failing raises an error that names each tier's reason.

One rule worth keeping: provider availability must be a cheap check, never a network
probe on every call. The plugin keeps an in-memory ledger — after all three tiers
fail it reports unavailable for a 60-second cooldown, so the harness stops routing
searches into a dead end.

## Fetch that goes around blocks

Search is only half of it: a result you cannot open is not a result. This plugin also
registers a fetch provider (`moon-fetch`) that keeps a mirror table and retries
through it whenever the direct request fails or returns a non-2xx.

- Covers `github.com`, `raw.githubusercontent.com`, `codeload.github.com`, and
  `api.github.com` through `ghfast.top` / `gh-proxy.com`, with `kkgithub` and
  `bgithub` as last resort.
- Mirror order is measured, not guessed: on 2026-10-26 the first two returned 200,
  `kkgithub` failed to connect, and `bgithub` returned 403 — so the working pair runs
  first.
- Charset is sniffed from the header and the first 4 KB before decoding, so GBK and
  GB2312 Chinese pages do not come back garbled.
- Errors name every address that was tried and why each one failed.

Registering a second fetch provider makes the harness see more than one available
provider, so pin it in the profile patch:

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: moon-local
    fetchProvider: moon-fetch
```

Leave `fetchProvider: http` to keep the official fetcher.

Self-test: `/rightbar-api/fetch-test?u=<url>` reports the final URL, status, length,
and the first 300 characters.

Self-test: `/rightbar-api/search-test?q=term` runs through DSH's own `ctx.web.search`
and reports `lastVia`, `lastCount`, `lastError`, and `downUntil`.

## Status

38 tools. **The environment is stated honestly** rather than passing clone results off
as desktop results.

**Verified on the Web clone** (`dsh web`, sidebar browser is an `<iframe>`):
`open` returns `frames: 1`; the whole `resize` path; `tabs`, `info`, `health`, `ops`,
`zoom`, `wait`, `find`, `style`, `eval`; and the rejection path of `scrape` and `history`.

**Verified on desktop** (Electron webview): an earlier 6-tool build was exercised one by
one on the author's own DSH 0.2.1-rc.2 desktop — `open` returned `frames: 1`, `read`
returned real page content (URL, title, 31 interactive elements, multilingual body),
`navigate` went through `webview.loadURL` and really changed the URL, `click` really
navigated, `shot` and `shot_full` wrote real screenshots. **The 38-tool build has not
been re-verified on desktop as a whole** — that is the next step once a restart is possible.

**Cannot be verified on the Web clone** (browser same-origin policy, not a plugin
defect): `read`, `click`, `fill`, `type`, `set_value`, `select`, `check`, `key`,
`scrape`, `download`, `cookies`, `a11y`, `controls`, `captcha`, `pdf`, `content` all need
to read inside the browser guest, and a cross-origin iframe refuses by design. Those
calls return an explicit same-origin message rather than a result. On desktop the guest
is a `<webview>` reached through `executeJavaScript`, which is not subject to that limit.

**Official assumptions checked before shipping** — from the author's own `app.asar`
build (0.2.1-rc.3), item by item rather than inferred: the `data-sidebar-browser-frame`
attribute, `createElement("webview")`, `host.append(element)`, the
`dshDesktop.protocolVersion === 1` branch, `loadURL`, `dom-ready`, and `openTab` are all
present and unchanged. CSS class hashes differ between the asar build and the npm
package (`bZwPEG_*` vs `SB_kFW_*`), but this plugin never references official class
names — only tag names, that data attribute, and public APIs.

`resize` measured on the clone (direct calls to the real functions plus the full chain):
the drag grip sits flush with the frame's bottom-right corner, gap 0 on both edges;
setting width 600 moves the frame from 745 to 600; a simulated 120 px mouse move widens
the frame by 120; `reset` returns to 745 leaving no inline residue; presets
`phone` 375 / `narrow` 480 / `wide` 720 / `wider` 960 all exact; an illegal width is
rejected with the preset list.

One implementation note: the official build puts the browser frame in a flex chain —
the frame and every ancestor container are `flex:1 1 auto`, so the width comes out of
the flex algorithm and writing `width` alone does nothing. `resize` uses
`width` + `flex:none` + `max-width` together to take the frame out of flex sizing.

Search side: against the self-hosted SearXNG a CJK query returned five real results in
2.5 s; pointed at a dead port it failed in 3 ms and then reported unavailable, instead
of stalling the whole call.

## Defects fixed along the way

Listed rather than hidden:

1. A missing `await` in the dispatch turned the tool result into an empty object, which
   looked like "called it, nothing happened".
2. `rightbar_scrape` returned empty field values when the field selector matched the
   item element itself — `querySelector` only searches descendants, never the element
   itself, and "field selector == item selector" is the most common shape (`item=a`
   with `a@href` to pull every link). The picker now tests the root with `matches()`
   first and falls back to descendants. Verified by isolating the pick logic against
   the same DOM before and after.
3. Four return fields (`alreadyHad`, `x`, `y`, `box`) were missing from the output
   schema and were silently dropped by validation, so the render branches that read
   them never fired.

## License

MIT

---

# rightbar-driver（中文）

驱动 DSH 右推栏里的内置浏览器。

## 它做什么

DSH 右推栏自带一个浏览器标签页（Ctrl+T，官方 `ui-sidebar-browser`）。页面能正常渲染，
但 agent 侧无法操作它——点什么、输什么都得你手动来。

这个插件让那个浏览器变得可操作，共 38 个工具，按用途分组：

**开门与导航**
- `rightbar_open` —— 打开右推栏浏览器标签页，可带网址
- `rightbar_navigate` —— 导航到指定网址
- `rightbar_nav` —— 前进、后退、刷新
- `rightbar_history` —— 查以前打开过哪些网页，本机持久化，跨会话跨重启
- `rightbar_tabs` —— 列出、切换、关闭标签页

**观察**
- `rightbar_read` —— 读页面文本与可交互元素（元素带 `dsh-ref-N` 句柄）
- `rightbar_a11y` —— 读无障碍树：语义角色、名称、状态。比 read 省上下文
- `rightbar_controls` —— 列表单控件的当前值与 ref
- `rightbar_captcha` —— 探测验证码位置与类型
- `rightbar_info` —— 地址、标题、加载状态、滚动位置
- `rightbar_shot` —— 截图存盘并返回路径（桌面版可用，可用 read_image 查看）
- `rightbar_shot_full` —— 整页截图，从顶到底一张图
- `rightbar_health` —— 查崩溃、加载、静音状况

**操作**
- `rightbar_click` —— 点击（也可给 x、y 按坐标点）
- `rightbar_fill` —— 填文本框
- `rightbar_type` —— 整段输入文字，像人一样逐字打进去
- `rightbar_set_value` —— 按 ref、选择器或标签文字设值或清空
- `rightbar_select` —— 选下拉框
- `rightbar_check` —— 勾选复选框或单选框
- `rightbar_key` —— 按键（Enter、Tab、方向键、Ctrl+A 等，桌面版为真实按键）
- `rightbar_scroll` —— 滚动页面

**框体大小**
- `rightbar_resize` —— 调节网页框大小。`handle` 在框右下角放一个拖动把手，拖动即改宽度；
  传像素数直接设宽；档位 `phone`(375) / `narrow`(480) / `wide`(720) / `wider`(960) 快速切换；
  `reset` 恢复官方默认。框一窄，网页的响应式布局自己就重排成手机端样子。

**查看与收存**
- `rightbar_zoom` —— 内核级缩放网页内容，不是改字号
- `rightbar_find` —— 页内查找文字
- `rightbar_pdf` —— 把当前页导出成 PDF
- `rightbar_style` —— 注入 CSS 调字号、隐藏浮层、换深色底
- `rightbar_eval` —— 在页面里执行脚本取回结果

**提取与下载**
- `rightbar_scrape` —— 按选择器把列表整理成 JSON
- `rightbar_download` —— 把文件下载到本机
- `rightbar_content` —— 把整页导出成 markdown、html、text 或 json

**登录态与收场**
- `rightbar_cookies` —— 存或灌 Cookie
- `rightbar_session_reset` —— 重建浏览器会话
- `rightbar_close` —— 关闭浏览器标签页

**记录与护栏**
- `rightbar_ops` —— 查每一步操作记录（带序号）
- `rightbar_replay` —— 重放动作，可按序号、区间或最近若干步
- `rightbar_restrict` —— 设置动作白名单（readonly 只读取）
- `rightbar_search_status` —— 查内置联网搜索当前走哪条路

开门与导航走官方公开 API `ctx.sidebarRight.openTab('browser', { params: { url } })`；
读取与交互通过官方桌面版使用的同一条通道在浏览器容器内执行。
不起额外进程、不起第二个浏览器、不占额外内存，也不碰你正在登录着的浏览器。

## 为什么会有它

市场上其他浏览器插件都是另起一个浏览器：Playwright 的 Chromium、Electron 窗口，
或者 CDP 连你自己的 Chrome。当你需要隔离、下载、登录态持久化时，那是对的。
但当你想用的浏览器本来就躺在右推栏里，你只是想让 agent 能使得动它时，
正确答案是这个。

## 使用前提

- 需要 DSH 桌面版。右推栏浏览器在桌面版是 Electron `<webview>` 渲染，
  这是能读到页面内容的原因。
- 需要有会话在屏幕上。否则官方 `sidebarRight.require()` 会抛
  "no session surface is mounted"——这是官方行为，不是插件限制。
- 在 `dsh web`（无桌面外壳）下，右推栏浏览器是 `<iframe>` 渲染。
  打开与导航仍然可用；读取与交互不可用，因为浏览器同源策略禁止读取跨域框架。
  插件会明确说明这一点，而不是抛一个看不懂的错。

## 安装

```
dsh plugin add github:Yingmoon0715/yingmoon-plugins#path:/plugins/rightbar-driver
```

或在 DSH 内的插件市场安装。

## 它还能顶替联网搜索

DeepSeek 官方联网搜索从 2026 年 11 月 1 日起按次收费。这个插件同时把自己注册成
DSH 的搜索提供方（ID 为 `moon-local`），于是 `web_search` 会走你自己的搜索源，
不再消耗官方额度。

三级回退，任何一层成功就返回：

1. **自建 SearXNG**（推荐）：本机通过 SSH 隧道连自己的实例。隧道由插件按需自动
   建立，断了下次重建。配置写在 `DSH_HOME/search-sources.json`。
2. **Tavily**：只在配置了 `tavilyKey` 时才用。
3. **右推栏真浏览器兜底**：依次打开搜狗、360、Bing，抓真实结果链接。
   这是最后手段，它会动右推栏的标签页。

三层全挂才报错，错误里逐条写清每一层为什么失败。

一条纪律：提供方的「可用性」必须是廉价判断，不能每次搜索都去探网络。插件用内存
记账——上一轮三层全挂之后进入 60 秒冷静期，冷静期内直接报不可用，不会让官方把
搜索派过来白等。

自测入口：`/rightbar-api/search-test?q=关键词`，它走 DSH 自己的 `ctx.web.search`，
返回里带 `lastVia`、`lastCount`、`lastError`、`downUntil`，一眼看出走的是哪一层。

## 抓取也能绕开封锁

搜索只是一半——搜到了打不开，等于没搜到。这个插件同时注册了抓取提供方
`moon-fetch`，内置镜像表，直连失败或返回非 2xx 时自动换镜像重试。

覆盖 `github.com`、`raw.githubusercontent.com`、`codeload.github.com`、
`api.github.com`，走 `ghfast.top` 与 `gh-proxy.com`，`kkgithub`、
`bgithub` 作最后备用。

镜像顺序是实测排出来的，不是猜的：2026-10-26 实测前两个返回 200，
`kkgithub` 连接失败、`bgithub` 返回 403，所以能用的排前面。

解码前会从响应头和前 4 KB 嗅探字符集，GBK、GB2312 的中文站不会变乱码。
失败时错误里逐条写明试过哪些地址、每个为什么失败。

注册第二个抓取提供方会让宿主看到多个可用提供方，所以要在 profile 补丁里固定：

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: moon-local
    fetchProvider: moon-fetch
```

想用回官方抓取，把 `fetchProvider` 改回 `http` 即可。

自测入口：`/rightbar-api/fetch-test?u=<网址>`，返回最终地址、状态、长度与开头
300 字。

## 当前状态

38 个工具。**验证环境与边界如实说明**，不把副本实测说成桌面版实测：

**在 Web 副本（`dsh web`，右推栏为 iframe）上实测通过：**
`open` 返回 `frames: 1`、`resize` 全套、`tabs`、`info`、`health`、`ops`、`zoom`、
`wait`、`find`、`style`、`eval`、`scrape` 的拒绝路径、以及 `history`。

**在桌面版（Electron webview）上实测通过：**
早期 6 工具版本曾在她本人的 DSH 0.2.1-rc.2 桌面版上逐个实调——`open` 返回
`frames: 1`、`read` 返回真实页面内容（URL/标题/31 个可交互元素/多语言正文）、
`navigate` 走 `webview.loadURL` 且网址真实改变、`click` 真实触发跳转、
`shot` 与 `shot_full` 写出真实截图。但**那之后插件又新增了 32 个工具，
这 38 个工具的版本尚未在桌面版上整体复验**。

**Web 副本上无法验证的（浏览器同源策略，非插件缺陷）：**
`read`、`click`、`fill`、`type`、`set_value`、`select`、`check`、`key`、
`scrape`、`download`、`cookies`、`a11y`、`controls`、`captcha`、`pdf`、
`content` 都要读网页容器内部，而 Web 副本的 iframe 跨域，实测返回的是明确的
同源限制提示而不是结果。桌面版 webview 走 `executeJavaScript`，不受此限。

**上真机前做过的官方前提核对**（从她本人 app.asar 的 0.2.1-rc.3 构建里逐条核出，
非推理）：`data-sidebar-browser-frame` 属性、`createElement("webview")`、
`host.append(element)`、`dshDesktop.protocolVersion === 1` 分支、`loadURL`、
`dom-ready`、`openTab` 均在且未变；CSS 类名哈希在 asar 与 npm 包之间不同
（`bZwPEG_*` 对 `SB_kFW_*`），但本插件从不引用官方类名，只依赖标签名、
那个 data 属性和公开 API，因此不受影响。

`resize` 的实测数据（副本，直接调真实函数 + 完整链路两条路）：拖动把手贴框右下角
（右下缝隙均为 0）；设宽 600 后框由 745 变为 600；模拟鼠标右移 120 像素，框宽
增加 120；`reset` 回到 745 且不留内联残痕；档位 `phone` 375 / `narrow` 480 /
`wide` 720 / `wider` 960 全部精确生效；非法宽度被拦下并提示可用档位。

一个实现要点：官方把网页框放在一条 flex 链里（框与各级父容器都是 `flex:1 1 auto`），
宽度由 flex 算法算出，所以只写 `width` 无效。`resize` 用 `width` + `flex:none` +
`max-width` 三件套让框退出 flex 自适应，宽度才说得上话。

搜索侧同样验过：接自建 SearXNG 时中文查询 2.5 秒返回 5 条真实结果；
把地址指向死端口时 3 毫秒失败、随后 `available()` 转为不可用，不再拖死一轮。

## 修过的缺陷

每一处都记在 README 里，不藏着：

1. dispatch 漏 `await`，工具结果被序列化成空对象，表现为"调了没反应"。
2. `rightbar_scrape` 在字段选择器命中条目自身时返回空值——`querySelector` 只搜
   后代不搜自身，而「字段选择器 == 条目选择器」是最常见用法。
3. 四个返回字段（`alreadyHad`、`x`、`y`、`box`）忘在输出 schema 里声明，
   被官方校验静默剥掉，render 里靠它们的分支永不生效。

## 许可

MIT
