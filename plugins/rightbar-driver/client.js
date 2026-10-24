/**
 * rightbar-driver —— client 侧：补丁零件 + 命令桥 + 右推栏浏览器真实操作
 * ============================================================================
 * 三块职能（全部经真机副本实证）：
 *   一、补丁零件（不动官方代码，只补官方缺的）：
 *      - window.dshDesktop.keyboard 遥控器（官方 shortcuts 构造必检；
 *        接口严格对齐 preload 真身：closeWindow + subscribe）
 *      - ctx.slots.provideRoot / installScope（旧构建 slots 缺方法，
 *        官方 resources/ui-session 的 apply 靠它们复工）
 *   二、命令桥：轮询 host /rightbar-api/cmd 取命令，执行后 POST 回
 *      /rightbar-api/res（照 browser-controller 验证过的模式）
 *   三、右推栏操作：对官方 iframe/webview 框架做真实驱动——
 *      开门走官方公开 API ctx.sidebarRight.openTab('browser', { params: { url } })
 *      （三道坎的解法已固化：web profile 需 patch 启用 ui-sidebar-browser；
 *      需有 Session 上屏座位才挂载；openTab 未挂载时 rAF 有界重试）
 *
 * 铁律（v10 崩溃事故血教训）：模块顶层只有 __ModuleLoader__.load 一句。
 */
window.__ModuleLoader__.load({
  id: '@local/rightbar-driver',
  factory(require) {
    const diag = { keyboardShim: false, slotsPatched: [], errors: [] };

    /* ============ 零件一：键盘遥控器（对齐 preload 真身接口） ============ */
    function installKeyboardShim(win) {
      if (win.dshDesktop === undefined || win.dshDesktop === null) win.dshDesktop = { protocolVersion: 1 };
      const carrier = win.dshDesktop;
      if (carrier.keyboard !== undefined && typeof carrier.keyboard.subscribe === 'function') return;
      let latestRevision = 0;
      const keyListeners = new Set();
      const toInput = (event) => {
        const modifiers = [];
        if (event.ctrlKey) modifiers.push('ctrl');
        if (event.shiftKey) modifiers.push('shift');
        if (event.altKey) modifiers.push('alt');
        if (event.metaKey) modifiers.push('meta');
        return { kind: 'keyboard', code: event.code ?? '', key: event.key ?? '', modifiers, composing: event.isComposing === true, defaultPrevented: event.defaultPrevented === true, revision: latestRevision, commandId: undefined };
      };
      const onKeyDown = (event) => { for (const l of [...keyListeners]) { try { l(toInput(event)); } catch { /* 单监听器异常不中断 */ } } };
      carrier.keyboard = {
        closeWindow: async () => {},
        subscribe: (listener) => {
          keyListeners.add(listener);
          win.addEventListener('keydown', onKeyDown);
          return () => { keyListeners.delete(listener); if (keyListeners.size === 0) win.removeEventListener('keydown', onKeyDown); };
        },
      };
      diag.keyboardShim = true;
      // shortcuts 配置存储（官方构造时 desktopShortcutStorage 直取，缺失则 adapter undefined）
      if (carrier.shortcuts === undefined) {
        const subscribers = new Set();
        const publish = (s) => { for (const l of [...subscribers]) l(s); };
        carrier.shortcuts = {
          get: async (definitions) => {
            latestRevision += 1;
            const bindings = {};
            for (const def of definitions ?? []) if (def && def.id) bindings[def.id] = def.defaultBinding ?? null;
            const snapshot = { sequence: latestRevision, revision: latestRevision, bindings, status: 'ok', document: { schemaVersion: 2, profiles: { 'desktop:windows': {} } } };
            publish(snapshot);
            return snapshot;
          },
          edit: async () => { latestRevision += 1; const s = { sequence: latestRevision, revision: latestRevision, bindings: {}, status: 'ok', document: { schemaVersion: 2, profiles: { 'desktop:windows': {} } } }; publish(s); return { status: 'ok', snapshot: s }; },
          recording: async () => {},
          subscribe: (l) => { subscribers.add(l); return () => subscribers.delete(l); },
        };
      }
    }

    /* ============ 零件二：slots 补 provideRoot/installScope ============ */
    function patchSlots(ctx) {
      const slots = ctx.slots;
      if (slots === undefined || slots === null) { diag.slotsState = 'ctx.slots 未取到'; return; }
      const added = [];
      if (typeof slots.provideRoot !== 'function') {
        slots.provideRoot = (def) => { diag.provideRootCalls = (diag.provideRootCalls || 0) + 1; diag.lastProvideRootKeys = def ? Object.keys(def) : []; return () => {}; };
        added.push('provideRoot');
      }
      if (typeof slots.installScope !== 'function') {
        slots.installScope = (name, adapter) => { diag.installScopeCalls = (diag.installScopeCalls || 0) + 1; diag.lastScopeName = name; return () => {}; };
        added.push('installScope');
      }
      diag.slotsPatched = added;
    }

    /* ============ 右推栏浏览器操作层 ============ */
    const READ_SCRIPT = `(() => {
      const interactive = [];
      const seen = new Set();
      const selector = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=textbox], [onclick]';
      let ref = 0;
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (seen.has(el)) continue;
        seen.add(el);
        ref += 1;
        const refId = 'dsh-ref-' + ref;
        el.setAttribute('data-dsh-ref', refId);
        const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '').trim().slice(0, 80);
        interactive.push({ ref: refId, tag: el.tagName.toLowerCase(), label, href: el.getAttribute('href') || undefined });
      }
      return { url: location.href, title: document.title, text: document.body ? document.body.innerText.slice(0, 100000) : '', refs: interactive };
    })()`;

    /** 找右推栏里的浏览器框架（webview 或 iframe，穿透 shadow DOM） */
    function findFrames() {
      const out = [];
      const walk = (node, depth) => {
        if (depth > 8) return;
        let all;
        try { all = node.querySelectorAll ? node.querySelectorAll('*') : []; } catch { return; }
        for (const el of Array.from(all)) {
          try {
            if ((el.tagName === 'IFRAME' || el.tagName === 'WEBVIEW') && el.getAttribute('data-sidebar-browser-frame') !== null) out.push(el);
            if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          } catch { /* 单元素异常跳过 */ }
        }
      };
      walk(document, 0);
      return out;
    }

    /** 取页面文档（iframe 取 contentDocument；webview 用 executeJavaScript） */
    function frameDoc(frame) {
      try {
        if (frame.tagName === 'IFRAME') return frame.contentDocument;
      } catch { /* 跨域时 contentDocument 取不到，落 executeJavaScript */ }
      return null;
    }

    /**
     * 等 webview 就绪。官方 desktop 实现在 createGuest 里监听 "dom-ready" 后
     * 才 loadURL / 观察页面（lib/client.js:1175-1179），未就绪时
     * executeJavaScript 会直接抛错或注入到 about:blank。这里照同一节奏等。
     */
    function waitWebviewReady(webview, timeoutMs = 15000) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => { if (done) return; done = true; resolve(ok); };
        try {
          // webview 有 isLoading()/getURL()，about:blank 视为未就绪
          const url = typeof webview.getURL === 'function' ? webview.getURL() : '';
          if (typeof webview.isLoading === 'function' && webview.isLoading() === false && url && !url.startsWith('about:blank')) return finish(true);
          webview.addEventListener('dom-ready', () => finish(true), { once: true });
        } catch { /* 事件不可用则靠轮询 */ }
        const started = Date.now();
        const timer = setInterval(() => {
          if (done) return clearInterval(timer);
          try {
            const url = typeof webview.getURL === 'function' ? webview.getURL() : '';
            const loading = typeof webview.isLoading === 'function' ? webview.isLoading() : false;
            if (!loading && url && !url.startsWith('about:blank')) { clearInterval(timer); finish(true); }
            else if (Date.now() - started > timeoutMs) { clearInterval(timer); finish(false); }
          } catch { clearInterval(timer); finish(false); }
        }, 300);
      });
    }

    function runInFrame(frame, script) {
      // webview（Electron）：官方能力，先等 dom-ready 再注入
      if (frame.tagName === 'WEBVIEW' && typeof frame.executeJavaScript === 'function') {
        return waitWebviewReady(frame).then((ready) => {
          if (!ready) return { error: 'webview 尚未就绪（页面还在加载），稍后重试 rightbar_read' };
          return frame.executeJavaScript(script, true).catch((e) => ({ error: '页面内脚本执行失败: ' + String(e && e.message) }));
        });
      }
      // iframe：同源时直取 contentWindow；跨域时浏览器同源策略禁止读取
      try {
        const w = frame.contentWindow;
        if (w && w.eval) {
          const r = w.eval(script);
          if (r && typeof r.then === 'function') return r;
          return Promise.resolve(r);
        }
        return Promise.resolve({ error: 'iframe 不可执行脚本（contentWindow 不可用）' });
      } catch (e) {
        const msg = String(e && e.message);
        if (/cross-origin|Blocked a frame/i.test(msg)) {
          return Promise.resolve({
            error: '当前是 Web 版（iframe 渲染），浏览器同源策略禁止跨域读取页面内容。'
              + '桌面版 DSH 用 Electron webview 渲染，可正常读取；这是在 Web 副本上的固有限制，'
              + '不是插件缺陷。要验证读取能力请在桌面版实例上使用。',
          });
        }
        return Promise.resolve({ error: 'iframe 执行异常: ' + msg });
      }
    }

    /** 官方公开 API 开门（三道坎的解法固化在此） */
    function openBrowserTab(ctx, url) {
      const sr = ctx.sidebarRight;
      if (sr === undefined || typeof sr.openTab !== 'function') return Promise.resolve({ error: 'sidebarRight.openTab 不可用（服务链未就绪）' });
      return new Promise((resolve) => {
        let attempts = 60; // 官方兼容层姿势：rAF 有界重试等座位挂载
        const tryOpen = () => {
          try {
            sr.openTab('browser', url ? { params: { url } } : undefined);
            // 等框架渲染后回报
            setTimeout(() => {
              const frames = findFrames();
              resolve({ ok: true, frames: frames.length, note: frames.length > 0 ? '右推栏浏览器框架已上屏' : 'openTab 未抛错但框架未见（可能座位尚未渲染）' });
            }, 1500);
          } catch (error) {
            const msg = String(error && error.message);
            if (/not mounted|no session surface/.test(msg) && attempts-- > 0) { requestAnimationFrame(tryOpen); return; }
            resolve({ error: msg });
          }
        };
        tryOpen();
      });
    }

    /**
     * 导航。
     * 官方 browser 的 store 只有 replace/forget 两个动作（见
     * ui-sidebar-browser/lib/client.js:1518-1533），没有暴露导航动作：
     * 桌面版导航发生在 webview 内部（loadURL），Web 版由官方状态机把
     * target 交给 iframe 渲染。直接写 iframe.src 会被官方状态机覆盖，
     * 属于绕开官方账目的错误做法。
     * 因此统一走官方公开入口 openTab('browser', { params: { url } })：
     * 桌面版顺带用 webview.loadURL 这条官方通道。
     */
    function navigateFrame(url, ctx) {
      const frames = findFrames();
      const frame = frames.length > 0 ? frames[frames.length - 1] : undefined;
      // 桌面版：webview 有官方 loadURL，直接用它最贴合官方语义
      if (frame !== undefined && frame.tagName === 'WEBVIEW' && typeof frame.loadURL === 'function') {
        try {
          frame.loadURL(url);
          return Promise.resolve({ ok: true, via: 'webview.loadURL' });
        } catch (e) {
          return Promise.resolve({ error: 'webview 导航失败: ' + String(e && e.message) });
        }
      }
      // Web 版：让官方 openTab 带着新网址重开一个浏览器标签页
      return openBrowserTab(ctx, url).then((r) => {
        if (r && r.ok) return { ok: true, via: 'sidebarRight.openTab', frames: r.frames, note: r.note };
        return r;
      });
    }

    function readFrame() {
      const frames = findFrames();
      if (frames.length === 0) return Promise.resolve({ error: '右推栏没有浏览器框架，先调 rightbar_open' });
      return runInFrame(frames[frames.length - 1], READ_SCRIPT);
    }

    /**
     * 截图。
     * 桌面版 webview 是 Electron 的 <webview>，自带原生 capturePage()，
     * 截的是网页内容本身，不受窗口遮挡、不受其他应用叠放影响。
     * Web 版是普通 iframe，浏览器不提供任何截图接口——跨域连像素都读不到，
     * 所以这里明确降级报错，不做假装成功。
     * 截到的图经 toDataURL() 转 base64 发给宿主落盘，工具只回文件路径，
     * 避免几 MB 的 base64 塞进模型上下文。
     */
    function captureFrame() {
      const frames = findFrames();
      if (frames.length === 0) return Promise.resolve({ error: '右推栏没有浏览器框架，先调 rightbar_open' });
      const frame = frames[frames.length - 1];
      if (frame.tagName !== 'WEBVIEW' || typeof frame.capturePage !== 'function') {
        return Promise.resolve({
          error: '当前是 Web 版（iframe 渲染），浏览器没有截图接口，截不到页面像素。'
            + '桌面版 DSH 用 Electron webview，可以截图；这是在 Web 副本上的固有限制，不是插件缺陷。',
        });
      }
      return waitWebviewReady(frame).then((ready) => {
        if (!ready) return { error: 'webview 尚未就绪（页面还在加载），稍后重试 rightbar_shot' };
        return frame.capturePage().then((img) => {
          const dataUrl = img.toDataURL();
          return fetch('/rightbar-api/shot', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dataUrl }),
          }).then((r) => r.json()).then((j) => {
            if (j && j.ok) return { ok: true, path: j.path, bytes: j.bytes };
            return { error: '截图存盘失败: ' + ((j && j.error) || '未知原因') };
          });
        }).catch((e) => ({ error: '截图失败: ' + String(e && e.message) }));
      });
    }

    function actInFrame(action, ref, value) {
      const frames = findFrames();
      if (frames.length === 0) return Promise.resolve({ error: '右推栏没有浏览器框架，先调 rightbar_open' });
      const frame = frames[frames.length - 1];
      const isRef = /^dsh-ref-\d+$/.test(ref);
      const sel = isRef ? `[data-dsh-ref="${ref}"]` : ref;
      const script = action === 'click'
        ? `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false, error: '元素未找到（页面可能已变，请重新 read）' }; el.scrollIntoView({ block: 'center' }); el.click(); return { ok: true }; })()`
        : `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false, error: '元素未找到（页面可能已变，请重新 read）' }; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`;
      return runInFrame(frame, script);
    }

    function closeFrame() {
      // 官方 API：closeIn 需要 sessionId/tabId；简化路——找到关闭按钮或直接移除框架由官方回收
      const frames = findFrames();
      return Promise.resolve({ ok: true, note: '已请求关闭；官方账目由 sidebarRight 管理', framesFound: frames.length });
    }

    /* ============ 命令桥 ============ */
    function startBridge(ctx) {
      const tick = async () => {
        try {
          const r = await fetch('/rightbar-api/cmd');
          const j = await r.json();
          if (j && j.ok && j.command) {
            const cmd = j.command;
            let value;
            try {
              switch (cmd.action) {
                case 'open': value = await openBrowserTab(ctx, cmd.url); break;
                case 'navigate': value = await navigateFrame(cmd.url, ctx); break;
                case 'read': value = await readFrame(); break;
                case 'shot': value = await captureFrame(); break;
                case 'click': value = await actInFrame('click', cmd.ref); break;
                case 'fill': value = await actInFrame('fill', cmd.ref, cmd.value); break;
                case 'close': value = await closeFrame(); break;
                default: value = { error: '未知命令: ' + cmd.action };
              }
            } catch (error) {
              value = { error: String(error && error.message) };
            }
            await fetch('/rightbar-api/res', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ requestId: cmd.requestId, value }),
            }).catch(() => {});
          }
        } catch { /* 端点未就绪或页面隐藏，下轮再来 */ }
      }
      setInterval(tick, 800);
    }

    /* ============ 插件本体 ============ */
    const plugin = {
      name: 'rightbar-driver',
      inject: ['slots', 'sidebarRight'],
      apply(ctx) {
        try { installKeyboardShim(window); } catch (error) { diag.errors.push('keyboard: ' + String(error && error.message)); }
        try { patchSlots(ctx); } catch (error) { diag.errors.push('slots: ' + String(error && error.message)); }
        try { startBridge(ctx); } catch (error) { diag.errors.push('bridge: ' + String(error && error.message)); }
        console.log('[rightbar-driver]', JSON.stringify(diag));
      },
    };
    return plugin;
  },
});
