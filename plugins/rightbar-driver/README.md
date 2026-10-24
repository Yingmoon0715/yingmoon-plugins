# rightbar-driver

Drive the built-in browser inside the DeepSeek Harness right sidebar.

## What it does

The DSH right sidebar ships a browser tab (Ctrl+T, the official `ui-sidebar-browser`).
It renders pages fine, but nothing could operate it from the agent side — you had to
click and type by hand.

This plugin makes that browser operable. Six tools:

- `rightbar_open` — open the sidebar browser tab, optionally with a URL
- `rightbar_navigate` — navigate to a URL
- `rightbar_read` — read the current page: URL, title, body text, and an interactive
  element list carrying `dsh-ref-N` handles
- `rightbar_click` — click an element by its `dsh-ref-N` handle or a CSS selector
- `rightbar_fill` — type into an input by handle or selector
- `rightbar_close` — close the tab

Opening and navigation go through the official public API
`ctx.sidebarRight.openTab('browser', { params: { url } })`. Reading and interaction
run inside the browser guest through the same channel the official desktop build
uses. No extra process, no extra browser, no memory overhead, and nothing touches
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
dsh plugin add https://github.com/<owner>/rightbar-driver
```

Or from the plugin market inside DSH.

## Status

First release. Six tools, verified end to end on DSH 0.2.1-rc.2 desktop:
`open` returns `frames: 1`, `read` returns real page content, `navigate` changes the
loaded URL, `click` navigates for real. Screenshots and roadmap (screenshot capture,
settings surface, skill bundle) are in `screenshots.json` and the issue tracker.

Not yet in this release: screenshots, downloads, cookie persistence, multi-session
isolation, CAPTCHA handling.

## License

MIT

---

# rightbar-driver（中文）

驱动 DSH 右推栏里的内置浏览器。

## 它做什么

DSH 右推栏自带一个浏览器标签页（Ctrl+T，官方 `ui-sidebar-browser`）。页面能正常渲染，
但 agent 侧无法操作它——点什么、输什么都得你手动来。

这个插件让那个浏览器变得可操作，提供六个工具：

- `rightbar_open` —— 打开右推栏浏览器标签页，可带网址
- `rightbar_navigate` —— 导航到指定网址
- `rightbar_read` —— 读取当前页面：网址、标题、正文、以及带 `dsh-ref-N` 句柄的可交互元素清单
- `rightbar_click` —— 按 `dsh-ref-N` 句柄或 CSS 选择器点击元素
- `rightbar_fill` —— 按句柄或选择器往输入框填字
- `rightbar_close` —— 关闭标签页

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
dsh plugin add https://github.com/<owner>/rightbar-driver
```

或在 DSH 内的插件市场安装。

## 当前状态

首个版本。六个工具已在 DSH 0.2.1-rc.2 桌面版端到端验证：
`open` 返回 `frames: 1`，`read` 返回真实页面内容，`navigate` 真实改变网址，
`click` 真实触发跳转。

这个版本还没有的：截图、下载、登录态持久化、多会话隔离、人机验证处理。

## 许可

MIT
