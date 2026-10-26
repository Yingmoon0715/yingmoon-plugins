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
    /**
     * 截图调用。
     * capturePage 偶发 UnknownVizError（合成帧还没备好时常见），
     * 隔一小会儿重试即可，不必让整次截图失败。
     */
    async function captureNative(frame, tries = 3) {
      let lastError = null;
      for (let i = 0; i < tries; i++) {
        try {
          return await frame.capturePage();
        } catch (e) {
          lastError = e;
          await new Promise((resolve) => setTimeout(resolve, 350));
        }
      }
      throw lastError || new Error('capturePage 连续失败');
    }

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
        return captureNative(frame).then((img) => {
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
        : action === 'focus'
          ? `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false, error: '元素未找到（页面可能已变，请重新 controls）' }; el.scrollIntoView({ block: 'center' }); if (el.focus) el.focus(); return { ok: true }; })()`
          : `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return { ok: false, error: '元素未找到（页面可能已变，请重新 read）' }; el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`;
      return runInFrame(frame, script);
    }

    /** 取当前要操作的框架；没有就返回错误对象，省得每个函数重复写。 */
    function lastFrame() {
      const frames = findFrames();
      if (frames.length === 0) return { error: '右推栏没有浏览器框架，先调 rightbar_open' };
      return { frame: frames[frames.length - 1], count: frames.length };
    }

    const refToSelector = (ref) => (/^dsh-ref-\d+$/.test(ref) ? `[data-dsh-ref="${ref}"]` : ref);

    /**
     * 等待页面条件成立。
     * 页面是异步渲染的，导航或点击之后立刻读，拿到的常是空白或旧内容——
     * 这是「读不到」最常见的假故障。这里按 250 毫秒一轮探测，直到命中或超时。
     * 不指定 selector/text 时，等的是 document.readyState === 'complete'。
     */
    async function waitInFrame(opts) {
      const picked = lastFrame();
      if (picked.error) return picked;
      const frame = picked.frame;
      const timeout = typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : 10000;
      const state = opts.state === 'hidden' ? 'hidden' : 'visible';
      const probe = `(() => {
        const sel = ${JSON.stringify(opts.selector || '')};
        const text = ${JSON.stringify(opts.text || '')};
        if (!sel && !text) return { found: document.readyState === 'complete', ready: document.readyState };
        let el = null;
        if (sel) { el = document.querySelector(sel); }
        else {
          const all = document.querySelectorAll('body *');
          for (const n of all) {
            if (n.children.length === 0 && (n.textContent || '').includes(text)) { el = n; break; }
          }
        }
        return { found: el !== null, ready: document.readyState };
      })()`;
      const started = Date.now();
      for (;;) {
        const r = await runInFrame(frame, probe);
        if (r && r.error) return r;
        const hit = state === 'hidden' ? r.found === false : r.found === true;
        if (hit) return { ok: true, waited: Date.now() - started, ready: r.ready };
        if (Date.now() - started >= timeout) {
          return { error: '等待超时（' + timeout + ' 毫秒）：' + (state === 'hidden' ? '元素仍在' : '条件未满足') };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    /** 下拉框选值。按 value 或选项文字匹配，两种都试，匹配到就用它。 */
    function selectInFrame(ref, value) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const script = `(() => {
        const el = document.querySelector(${JSON.stringify(refToSelector(ref))});
        if (!el) return { ok: false, error: '元素未找到（页面可能已变，请重新 read）' };
        if (el.tagName !== 'SELECT') return { ok: false, error: '这个元素不是下拉框，实际是 ' + el.tagName };
        const want = ${JSON.stringify(value)};
        let hit = null;
        for (const opt of Array.from(el.options)) {
          if (opt.value === want || (opt.textContent || '').trim() === want) { hit = opt; break; }
        }
        if (hit === null) {
          return { ok: false, error: '下拉框里没有这一项: ' + want,
                   options: Array.from(el.options).map((o) => o.value + ' | ' + (o.textContent || '').trim()).slice(0, 30) };
        }
        el.value = hit.value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, picked: hit.value, label: (hit.textContent || '').trim() };
      })()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * 勾选或取消复选框、单选框。
     * 状态已经对了就不动；不一致时走 click()，这样页面上的事件监听器都会收到通知，
     * 单纯改 checked 不会触发它们。
     */
    function checkInFrame(ref, checked) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const script = `(() => {
        const el = document.querySelector(${JSON.stringify(refToSelector(ref))});
        if (!el) return { ok: false, error: '元素未找到（页面可能已变，请重新 read）' };
        const type = (el.type || '').toLowerCase();
        if (type !== 'checkbox' && type !== 'radio') {
          return { ok: false, error: '这个元素不是复选框或单选框，实际是 ' + (el.tagName + (type ? '[' + type + ']' : '')) };
        }
        const want = ${JSON.stringify(checked === true)};
        if (el.checked === want) return { ok: true, already: true, checked: el.checked };
        el.click();
        return { ok: true, checked: el.checked };
      })()`;
      return runInFrame(picked.frame, script);
    }

    /** 滚动页面：整页顶底、按像素、或滚到某个元素。 */
    function scrollInFrame(opts) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const script = `(() => {
        const ref = ${JSON.stringify(opts.ref || '')};
        const to = ${JSON.stringify(opts.to || '')};
        const amount = ${JSON.stringify(typeof opts.amount === 'number' ? opts.amount : 600)};
        if (ref) {
          const el = document.querySelector(${JSON.stringify(opts.ref ? refToSelector(opts.ref) : '')});
          if (!el) return { ok: false, error: '元素未找到（页面可能已变，请重新 read）' };
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return { ok: true, via: 'element', y: Math.round(window.scrollY) };
        }
        if (to === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
        else if (to === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
        else window.scrollBy({ top: amount, behavior: 'smooth' });
        return { ok: true, via: to || 'by', y: Math.round(window.scrollY) };
      })()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * 前进、后退、刷新。
     * 桌面版 webview 有原生 goBack/goForward/reload，用它最贴合官方语义；
     * iframe 没有这些方法，退回页面内 history 与 location。
     */
    function historyAction(action) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const frame = picked.frame;
      if (frame.tagName === 'WEBVIEW') {
        try {
          if (action === 'back') {
            if (typeof frame.canGoBack === 'function' && frame.canGoBack() === false) return Promise.resolve({ error: '已经是第一页，没有可后退的记录' });
            frame.goBack();
            return Promise.resolve({ ok: true, via: 'webview.goBack' });
          }
          if (action === 'forward') {
            if (typeof frame.canGoForward === 'function' && frame.canGoForward() === false) return Promise.resolve({ error: '已经是最后一页，没有可前进的记录' });
            frame.goForward();
            return Promise.resolve({ ok: true, via: 'webview.goForward' });
          }
          frame.reload();
          return Promise.resolve({ ok: true, via: 'webview.reload' });
        } catch (e) {
          return Promise.resolve({ error: 'webview 历史操作失败: ' + String(e && e.message) });
        }
      }
      const script = action === 'back' ? '(() => { history.back(); return { ok: true, via: "history.back" }; })()'
        : action === 'forward' ? '(() => { history.forward(); return { ok: true, via: "history.forward" }; })()'
          : '(() => { location.reload(); return { ok: true, via: "location.reload" }; })()';
      return runInFrame(frame, script);
    }

    /**
     * 页面缩放。
     * 官方 <webview> 自带 setZoomFactor/getZoomFactor（Electron 文档 webview-tag
     * 一节明列），这是浏览器内核级的缩放，整个网页连同图片文字一起缩，
     * 不是改 CSS 字号那种凑合做法。右推栏本身窄，把页面缩到 70% 左右
     * 就能在窄栏里看到接近完整宽度的布局。
     * 只影响当前这个 webview 实例，不动 DSH 界面本身。
     */
    function zoomFrame(factor) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const frame = picked.frame;
      if (frame.tagName !== 'WEBVIEW' || typeof frame.setZoomFactor !== 'function') {
        return Promise.resolve({
          error: '当前是 Web 版（iframe 渲染），浏览器没有提供页面缩放接口。'
            + '桌面版 DSH 用 Electron webview，可以调缩放；这是 Web 副本的固有限制。',
        });
      }
      try {
        if (factor === 'get') {
          const now = typeof frame.getZoomFactor === 'function' ? frame.getZoomFactor() : null;
          return Promise.resolve({ ok: true, factor: now });
        }
        const f = Number(factor);
        if (!Number.isFinite(f) || f < 0.25 || f > 5) {
          return Promise.resolve({ error: '缩放倍数要在 0.25 到 5 之间，例如 0.75 表示 75%' });
        }
        frame.setZoomFactor(f);
        const now = typeof frame.getZoomFactor === 'function' ? frame.getZoomFactor() : f;
        return Promise.resolve({ ok: true, factor: now });
      } catch (e) {
        return Promise.resolve({ error: '设置缩放失败: ' + String(e && e.message) });
      }
    }

    /**
     * 网页框尺寸调节（2026-10-26 按玥玥要求做）。
     *
     * 官方把网页框（iframe/webview）放在一条 flex 链里：框自己是
     * flex:1 1 auto，父容器 SB_kFW_viewport / _content / _root 也全是
     * flex:1 1 auto，宽度由 flex 算法算出来（副本实测 745px）。
     * 所以只写 width:600px !important 无效——flex-basis:auto 会把宽度
     * 拉回自适应；改父容器 width 也无效，父容器同样受它的父级 flex 约束。
     *
     * 唯一有效的配方（副本实测，可重复）：width + flex:none + max-width。
     * flex:none 让框退出 flex 自适应，width 才说得上话。
     */
    /**
     * 框与把手的登记表。
     * applyFrameWidth 改完宽度后要能通知把手重新定位，否则把手会留在旧位置
     * （副本实测：设宽 600 后把手还在 x=728，跑到框外 145px）。
     * 用 WeakMap 记，不阻止垃圾回收。
     */
    const handleRegistry = new WeakMap();

    function applyFrameWidth(frame, w) {
      frame.style.setProperty('width', w + 'px', 'important');
      frame.style.setProperty('flex', 'none', 'important');
      frame.style.setProperty('max-width', w + 'px', 'important');
      // 改完立刻把把手挪到新右下角，别等 ResizeObserver 那一拍
      const h = handleRegistry.get(frame);
      if (h) {
        const r = frame.getBoundingClientRect();
        h.style.left = Math.round(r.right - 18) + 'px';
        h.style.top = Math.round(r.bottom - 18) + 'px';
      }
    }

    function clearFrameWidth(frame) {
      frame.style.removeProperty('width');
      frame.style.removeProperty('flex');
      frame.style.removeProperty('max-width');
    }

    /**
     * 挂拖动把手。
     *
     * 两个坑（2026-10-26 副本实测踩到）：
     * 一、webview/iframe 不能往它内部塞 DOM，把手只能挂到父节点。但父容器
     *    （SB_kFW_viewport）比框本身窄，用 right:0 bottom:0 挂在父节点上，
     *    把手会落在父容器右下角而不是框的右下角——实测错位 170+ 像素。
     *    解法：挂到父节点但用 position:fixed 加框的实时 rect 定位，
     *    并用 ResizeObserver 让把手跟着框走。
     * 二、onMove 用 e.movementX 在合成事件与部分输入法场景下不可靠，
     *    改为记录 mousedown 时的起点 clientX 与起点宽度，用增量算。
     */
    function ensureResizeHandle(frame) {
      if (frame.dataset.rbHandle === 'on') return false;
      frame.dataset.rbHandle = 'on';
      const host = frame.parentNode;
      if (!host) return false;
      const handle = document.createElement('div');
      handle.dataset.rbResizeHandle = 'on';
      handle.title = '拖动改变网页框宽度';
      handle.style.cssText = [
        'position:fixed', 'width:18px', 'height:18px',
        'cursor:ew-resize', 'z-index:99999', 'opacity:0.25',
        'background:linear-gradient(135deg,transparent 50%,currentcolor 50%)',
        'color:#888', 'border-bottom-right-radius:4px',
      ].join(';');
      handle.addEventListener('mouseenter', () => { handle.style.opacity = '0.85'; });
      handle.addEventListener('mouseleave', () => { handle.style.opacity = '0.25'; });

      // 把手贴到框的右下角（fixed 定位，用框实时 rect）
      const place = () => {
        const r = frame.getBoundingClientRect();
        handle.style.left = Math.round(r.right - 18) + 'px';
        handle.style.top = Math.round(r.bottom - 18) + 'px';
      };
      place();
      // 框尺寸一变就把把手挪过去；rAF 节流，别和拖动抢
      let raf = 0;
      const follow = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; place(); });
      };
      if (typeof ResizeObserver === 'function') {
        try { new ResizeObserver(follow).observe(frame); } catch { /* 不支持就靠轮询 */ }
      }
      window.addEventListener('resize', follow);
      // 官方布局变化时也跟一次（短窗轮询，够用且不常驻）
      const followTimer = setInterval(place, 1000);
      handle.dataset.rbFollowTimer = String(followTimer);

      let startX = 0;
      let startW = 0;
      const onMove = (e) => {
        const next = Math.max(240, Math.round(startW + (e.clientX - startX)));
        applyFrameWidth(frame, next);
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.userSelect = '';
      };
      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const r = frame.getBoundingClientRect();
        startX = e.clientX;
        startW = Math.round(r.width);
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });
      host.appendChild(handle);
      // 登记，让 applyFrameWidth 改完宽度能立刻把把手挪过来
      handleRegistry.set(frame, handle);
      return true;
    }

    function resizeFrame(spec) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const frame = picked.frame;
      // 改宽高是纯 DOM/CSS 操作，iframe 与 webview 都支持：
      // 同源策略只禁止读 iframe 的内容，不禁止改这个元素自身的盒模型。
      try {
        if (spec === 'handle') {
          const made = ensureResizeHandle(frame);
          const rect = frame.getBoundingClientRect();
          return Promise.resolve({
            ok: true,
            note: made ? '拖动把手已放好，拖网页框右下角即可改宽度' : '拖动把手本来就在，直接拖右下角',
            width: Math.round(rect.width), height: Math.round(rect.height),
            alreadyHad: !made,
          });
        }
        const PRESETS = { phone: 375, narrow: 480, wide: 720, wider: 960 };
        if (spec === 'reset' || spec === 'default') {
          clearFrameWidth(frame);
          const rect = frame.getBoundingClientRect();
          return Promise.resolve({ ok: true, note: '已恢复官方默认宽度', width: Math.round(rect.width) });
        }
        const w = PRESETS[spec] !== undefined ? PRESETS[spec] : Number(spec);
        if (!Number.isFinite(w) || w < 240 || w > 4000) {
          return Promise.resolve({
            error: '宽度要在 240 到 4000 像素之间；也可用档位名：' + Object.keys(PRESETS).join('、'),
          });
        }
        applyFrameWidth(frame, w);
        const rect = frame.getBoundingClientRect();
        return Promise.resolve({ ok: true, width: Math.round(rect.width), asked: w });
      } catch (e) {
        return Promise.resolve({ error: '改尺寸失败: ' + String(e && e.message) });
      }
    }

    /**
     * 页内查找。
     * 走 webview 原生 findInPage，等同于浏览器 Ctrl+F：
     * 会高亮命中项并滚动到第一处。命中数量通过 found-in-page 事件回传，
     * 这里注册一次性监听拿结果。
     */
    function findInFrame(text, forward) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const frame = picked.frame;
      if (frame.tagName !== 'WEBVIEW' || typeof frame.findInPage !== 'function') {
        return Promise.resolve({ error: '当前是 Web 版（iframe 渲染），没有页内查找接口。桌面版可用。' });
      }
      return new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        try {
          frame.addEventListener('found-in-page', (event) => {
            const r = event.result || {};
            finish({ ok: true, matches: r.matches, active: r.activeMatchOrdinal, finalUpdate: r.finalUpdate === true });
          }, { once: true });
          frame.findInPage(text, { forward: forward !== false });
          setTimeout(() => finish({ ok: true, note: '已发出查找请求，但没等到命中数量回传' }), 4000);
        } catch (e) {
          finish({ error: '页内查找失败: ' + String(e && e.message) });
        }
      });
    }

    /**
     * 把当前页面导出成 PDF，存到本机。
     * webview 原生 printToPDF 返回 Uint8Array，发给宿主落盘。
     * 用处：把网页正文留下来慢慢看，或者给你一份能离线打开的存档。
     */
    function pdfFrame() {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const frame = picked.frame;
      if (frame.tagName !== 'WEBVIEW' || typeof frame.printToPDF !== 'function') {
        return Promise.resolve({ error: '当前是 Web 版（iframe 渲染），没有导出 PDF 的接口。桌面版可用。' });
      }
      return waitWebviewReady(frame).then((ready) => {
        if (!ready) return { error: 'webview 尚未就绪，稍后重试' };
        return frame.printToPDF({ printBackground: true, pageSize: 'A4' }).then((data) => {
          const bytes = new Uint8Array(data);
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          }
          const base64 = btoa(bin);
          return fetch('/rightbar-api/shot', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ dataUrl: 'data:application/pdf;base64,' + base64, ext: 'pdf', kind: 'pdf' }),
          }).then((r) => r.json()).then((j) => {
            if (j && j.ok) return { ok: true, path: j.path, bytes: j.bytes };
            return { error: 'PDF 存盘失败: ' + ((j && j.error) || '未知原因') };
          });
        }).catch((e) => ({ error: '导出 PDF 失败: ' + String(e && e.message) }));
      });
    }

    /**
     * 在当前页面里注入一段 CSS。
     * 官方 webview 有 insertCSS/removeInsertedCSS，返回的 key 可以用来撤销。
     * 常用场景：把字号放大、隐藏遮挡内容的浮层、换成深色底。
     * 只是当前这一次生效，刷新页面就回到原样。
     */
    function styleFrame(css, key) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const frame = picked.frame;
      if (frame.tagName !== 'WEBVIEW' || typeof frame.insertCSS !== 'function') {
        return Promise.resolve({ error: '当前是 Web 版（iframe 渲染），没有注入样式的接口。桌面版可用。' });
      }
      if (key) {
        return Promise.resolve(frame.removeInsertedCSS(key)).then(() => ({ ok: true, removed: key }))
          .catch((e) => ({ error: '撤销样式失败: ' + String(e && e.message) }));
      }
      return Promise.resolve(frame.insertCSS(css)).then((k) => ({ ok: true, key: k }))
        .catch((e) => ({ error: '注入样式失败: ' + String(e && e.message) }));
    }

    /** 页面健康与静音：崩溃检测、静音开关。 */
    function frameHealth(action, muted) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const frame = picked.frame;
      if (frame.tagName !== 'WEBVIEW') {
        return Promise.resolve({ error: '当前是 Web 版（iframe 渲染），没有这些接口。桌面版可用。' });
      }
      try {
        if (action === 'mute') {
          frame.setAudioMuted(muted !== false);
          return Promise.resolve({ ok: true, muted: muted !== false });
        }
        return Promise.resolve({
          ok: true,
          crashed: typeof frame.isCrashed === 'function' ? frame.isCrashed() : null,
          loading: typeof frame.isLoading === 'function' ? frame.isLoading() : null,
          muted: typeof frame.isAudioMuted === 'function' ? frame.isAudioMuted() : null,
          audible: typeof frame.isCurrentlyAudible === 'function' ? frame.isCurrentlyAudible() : null,
          url: typeof frame.getURL === 'function' ? frame.getURL() : null,
          title: typeof frame.getTitle === 'function' ? frame.getTitle() : null,
        });
      } catch (e) {
        return Promise.resolve({ error: '读取页面健康状态失败: ' + String(e && e.message) });
      }
    }

    /**
     * 键盘输入。
     * 桌面版 webview 走 Electron 原生 sendInputEvent：这是真实按键，
     * Tab 会移焦、Enter 会提交、方向键能翻页，和亲手按完全一样。
     * Web 版 iframe 只能派发合成 KeyboardEvent——页面自己的监听器收得到，
     * 但浏览器的默认行为不会发生。两种能力分开如实回报，不假装等价。
     */
    const KEY_ALIAS = {
      enter: 'Enter', return: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape',
      space: 'Space', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
      up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
      pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', insert: 'Insert',
    };

    function parseKeySpec(spec) {
      const parts = String(spec).split('+').map((s) => s.trim()).filter((s) => s !== '');
      const modifiers = [];
      let key = '';
      for (const part of parts) {
        const low = part.toLowerCase();
        if (low === 'ctrl' || low === 'control') modifiers.push('control');
        else if (low === 'alt' || low === 'option') modifiers.push('alt');
        else if (low === 'shift') modifiers.push('shift');
        else if (low === 'meta' || low === 'win' || low === 'cmd' || low === 'command') modifiers.push('meta');
        else key = part;
      }
      const low = key.toLowerCase();
      let char = '';
      if (KEY_ALIAS[low] !== undefined) key = KEY_ALIAS[low];
      else if (/^f([1-9]|1[0-2])$/.test(low)) key = low.toUpperCase();
      else if (key.length === 1) {
        // keyDown 用大写的键码，char 事件带真实字符：不按 Shift 时是小写
        char = modifiers.indexOf('shift') >= 0 ? key.toUpperCase() : key.toLowerCase();
        key = key.toUpperCase();
      }
      return { key, modifiers, char };
    }

    async function pressKeyInFrame(opts) {
      const picked = lastFrame();
      if (picked.error) return picked;
      const frame = picked.frame;
      const spec = String(opts.key || '').trim();
      if (spec === '') return { error: '要说明按哪个键，例如 Enter、Tab、Escape、ArrowDown、Ctrl+A' };
      const parsed = parseKeySpec(spec);
      if (parsed.key === '') {
        return { error: '按键写法看不懂: ' + spec + '（可用 Enter、Tab、Escape、方向键、F1-F12、单个字母数字，或 Ctrl+A 这种组合）' };
      }
      const times = typeof opts.times === 'number' && opts.times > 0 ? Math.min(Math.round(opts.times), 50) : 1;
      if (opts.ref) {
        const focus = await actInFrame('focus', opts.ref);
        if (focus && focus.error) return focus;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (frame.tagName === 'WEBVIEW' && typeof frame.sendInputEvent === 'function') {
        const ready = await waitWebviewReady(frame);
        if (!ready) return { error: 'webview 尚未就绪（页面还在加载），稍后重试' };
        try {
          try { frame.focus(); } catch { /* 不可聚焦时忽略，按键仍会派给页面 */ }
          const typeChar = parsed.key.length === 1 && !parsed.modifiers.some((m) => m !== 'shift');
          for (let i = 0; i < times; i++) {
            frame.sendInputEvent({ type: 'keyDown', keyCode: parsed.key, modifiers: parsed.modifiers });
            if (typeChar) frame.sendInputEvent({ type: 'char', keyCode: parsed.char || parsed.key, modifiers: parsed.modifiers });
            frame.sendInputEvent({ type: 'keyUp', keyCode: parsed.key, modifiers: parsed.modifiers });
          }
          return { ok: true, via: 'webview.sendInputEvent', key: spec, times };
        } catch (e) {
          return { error: '发送按键失败: ' + String(e && e.message) };
        }
      }
      const script = `(() => {
        const p = ${JSON.stringify({ key: parsed.key, modifiers: parsed.modifiers, times })};
        const target = document.activeElement || document.body;
        for (let i = 0; i < p.times; i++) {
          for (const type of ['keydown', 'keypress', 'keyup']) {
            target.dispatchEvent(new KeyboardEvent(type, {
              key: p.key,
              ctrlKey: p.modifiers.indexOf('control') >= 0,
              altKey: p.modifiers.indexOf('alt') >= 0,
              shiftKey: p.modifiers.indexOf('shift') >= 0,
              metaKey: p.modifiers.indexOf('meta') >= 0,
              bubbles: true,
              cancelable: true,
            }));
          }
        }
        return { ok: true, dispatched: p.times, target: target.tagName };
      })()`;
      const out = await runInFrame(frame, script);
      if (out && out.error) return out;
      return {
        ...out,
        via: 'dispatchEvent',
        note: 'Web 版只能派发合成键盘事件：页面自己的监听器会收到，但浏览器的默认行为（Tab 移焦、Enter 提交）不会发生。桌面版是真实按键。',
      };
    }

    /**
     * 表单控件清单。
     * 一次性把页面上所有输入框、下拉框、勾选框的当前值、标签和状态列出来，
     * 省得为了确认「刚才有没有填进去」而反复整页读。
     * 这里分配的 ref 与 rightbar_fill / rightbar_select / rightbar_check 通用。
     */
    function controlsInFrame() {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const script = `(() => {
        const out = [];
        let ref = 0;
        const sel = 'input:not([type=hidden]), textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="switch"]';
        const labelMap = new Map();
        for (const lab of document.querySelectorAll('label[for]')) {
          labelMap.set(lab.getAttribute('for'), (lab.innerText || '').trim().slice(0, 80));
        }
        const labelOf = (el) => {
          const aria = el.getAttribute('aria-label');
          if (aria) return aria.trim().slice(0, 80);
          const by = el.getAttribute('aria-labelledby');
          if (by) { const n = document.getElementById(by); if (n) return (n.innerText || '').trim().slice(0, 80); }
          if (el.id && labelMap.has(el.id)) return labelMap.get(el.id);
          const wrap = el.closest ? el.closest('label') : null;
          if (wrap) return (wrap.innerText || '').trim().slice(0, 80);
          return (el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '').trim().slice(0, 80);
        };
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          ref += 1;
          const refId = 'dsh-ref-' + ref;
          el.setAttribute('data-dsh-ref', refId);
          const role = el.getAttribute('role');
          const tag = el.tagName.toLowerCase();
          let type = (el.getAttribute('type') || '').toLowerCase();
          if (type === '') {
            if (tag === 'select') type = 'select';
            else if (tag === 'textarea') type = 'textarea';
            else if (el.isContentEditable) type = 'contenteditable';
            else type = role || tag;
          }
          const item = {
            ref: refId,
            type,
            label: labelOf(el),
            disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
            readonly: el.readOnly === true || el.getAttribute('aria-readonly') === 'true',
            required: el.required === true || el.getAttribute('aria-required') === 'true',
          };
          if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'switch') {
            item.checked = el.checked !== undefined ? el.checked : el.getAttribute('aria-checked') === 'true';
          } else if (tag === 'select') {
            item.value = el.value;
            item.multiple = el.multiple === true;
            item.options = Array.from(el.options).slice(0, 40).map((o) => (o.value === (o.textContent || '').trim() ? o.value : o.value + ' | ' + (o.textContent || '').trim()));
          } else if (el.isContentEditable) {
            item.value = (el.innerText || '').slice(0, 300);
          } else {
            item.value = String(el.value === undefined ? '' : el.value).slice(0, 300);
          }
          out.push(item);
        }
        return { url: location.href, count: out.length, controls: out };
      })()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * 验证码探测。
     * 只负责找到「验证码长在哪、属于哪一类」：滑块、图形码、点选、第三方框架。
     * 找到之后由你决定怎么处理——截图看清楚、拖滑块、还是停下来问她。
     */
    function captchaInFrame() {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const script = `(() => {
        const KEY = /captcha|verify|verification|geetest|recaptcha|hcaptcha|turnstile|nc_|yzm|challenge|slide|puzzle|slider|验证码|滑块|拖动|安全验证/i;
        const hits = [];
        let ref = 0;
        const mark = (el, kind, hint) => {
          const r = el.getBoundingClientRect();
          const visible = r.width > 0 && r.height > 0;
          if (!visible) return;
          ref += 1;
          const refId = 'dsh-ref-' + ref;
          el.setAttribute('data-dsh-ref', refId);
          hits.push({
            ref: refId,
            kind,
            tag: el.tagName.toLowerCase(),
            hint: String(hint || '').slice(0, 120),
            box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          });
        };
        for (const fr of document.querySelectorAll('iframe')) {
          const blob = (fr.getAttribute('src') || '') + ' ' + (fr.getAttribute('name') || '') + ' ' + (fr.getAttribute('title') || '');
          if (KEY.test(blob)) mark(fr, '第三方验证框架', blob);
        }
        for (const el of document.querySelectorAll('img, canvas, input, div, span, button, section')) {
          const blob = [el.getAttribute('id'), el.getAttribute('class'), el.getAttribute('name'), el.getAttribute('src'), el.getAttribute('placeholder'), el.getAttribute('aria-label')].filter(Boolean).join(' ');
          if (blob !== '' && KEY.test(blob)) {
            const tag = el.tagName.toLowerCase();
            const kind = tag === 'img' ? '图形验证码' : tag === 'canvas' ? '画布验证码' : tag === 'input' ? '验证输入框' : '验证组件';
            mark(el, kind, blob);
          }
        }
        const text = document.body ? document.body.innerText : '';
        const hints = text.split('\\n').map((l) => l.trim()).filter((l) => l !== '' && /验证码|拖动|滑块|验证|安全验证/.test(l)).slice(0, 10);
        return { url: location.href, found: hits.length > 0, count: hits.length, hits: hits.slice(0, 20), textHints: hints };
      })()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * 无障碍树。
     * 按页面的语义角色（link/button/textbox/heading…）+ 可读名称 + 状态
     * 组织成缩进树，读的是屏幕阅读器会用的那套信息。
     * 注意：这是从 DOM 语义推导出来的，不是 Chromium 的 AXTree；
     * 对绝大多数网页足够定位元素，遇到 canvas 自绘界面仍然要靠截图。
     */
    function a11yInFrame() {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const script = `(() => {
        const OUT = [];
        let ref = 0;
        const NAME = (el) => {
          const aria = el.getAttribute('aria-label');
          if (aria && aria.trim() !== '') return aria.trim().slice(0, 100);
          const by = el.getAttribute('aria-labelledby');
          if (by) {
            const names = by.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => (n.innerText || '').trim()).filter((t) => t !== '');
            if (names.length > 0) return names.join(' ').slice(0, 100);
          }
          const alt = el.getAttribute('alt');
          if (alt && alt.trim() !== '') return alt.trim().slice(0, 100);
          if (el.id) {
            const lab = document.querySelector('label[for="' + el.id.replace(/"/g, '\\\\"') + '"]');
            if (lab) return (lab.innerText || '').trim().slice(0, 100);
          }
          const wrap = el.closest ? el.closest('label') : null;
          if (wrap) return (wrap.innerText || '').trim().slice(0, 100);
          const ph = el.getAttribute('placeholder');
          if (ph && ph.trim() !== '') return ph.trim().slice(0, 100);
          const txt = (el.innerText || '').trim().replace(/\\s+/g, ' ');
          if (txt !== '' && txt.length <= 100) return txt;
          const title = el.getAttribute('title');
          if (title && title.trim() !== '') return title.trim().slice(0, 100);
          return txt.slice(0, 100);
        };
        const ROLE = (el) => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit;
          const tag = el.tagName;
          if (tag === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
          if (tag === 'BUTTON') return 'button';
          if (tag === 'SELECT') return el.multiple ? 'listbox' : 'combobox';
          if (tag === 'TEXTAREA') return 'textbox';
          if (tag === 'INPUT') {
            const t = (el.getAttribute('type') || 'text').toLowerCase();
            if (t === 'checkbox') return 'checkbox';
            if (t === 'radio') return 'radio';
            if (t === 'range') return 'slider';
            if (t === 'search') return 'searchbox';
            if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
            if (t === 'hidden') return 'none';
            return 'textbox';
          }
          if (tag === 'IMG') return 'img';
          if (/^H[1-6]$/.test(tag)) return 'heading';
          if (tag === 'NAV') return 'navigation';
          if (tag === 'MAIN') return 'main';
          if (tag === 'FORM') return 'form';
          if (tag === 'TABLE') return 'table';
          if (tag === 'TR') return 'row';
          if (tag === 'TD' || tag === 'TH') return 'cell';
          if (tag === 'UL' || tag === 'OL') return 'list';
          if (tag === 'LI') return 'listitem';
          if (tag === 'DIALOG') return 'dialog';
          if (el.isContentEditable) return 'textbox';
          if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return 'button';
          return 'generic';
        };
        const ACTIONABLE = { link: 1, button: 1, textbox: 1, searchbox: 1, checkbox: 1, radio: 1, combobox: 1, listbox: 1, option: 1, switch: 1, slider: 1, menuitem: 1, tab: 1 };
        const walk = (el, depth) => {
          if (OUT.length >= 400 || depth > 14) return;
          let role = ROLE(el);
          if (role === 'none') return;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true') return;
          const isHeading = /^H[1-6]$/.test(el.tagName);
          const hasAria = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.hasAttribute('aria-describedby');
          const keeping = role !== 'generic' || hasAria;
          if (keeping) {
            const node = { depth, role: isHeading ? 'heading' : role };
            const name = NAME(el);
            if (name !== '') node.name = name;
            if (isHeading) node.level = Number(el.tagName.slice(1));
            if (ACTIONABLE[role]) {
              ref += 1;
              node.ref = 'dsh-ref-' + ref;
              el.setAttribute('data-dsh-ref', node.ref);
            }
            if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
            if (el.checked !== undefined && (role === 'checkbox' || role === 'radio' || role === 'switch')) node.checked = el.checked === true;
            else if (el.getAttribute('aria-checked')) node.checked = el.getAttribute('aria-checked') === 'true';
            const exp = el.getAttribute('aria-expanded');
            if (exp !== null) node.expanded = exp === 'true';
            const sel = el.getAttribute('aria-selected');
            if (sel !== null) node.selected = sel === 'true';
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
              if (el.value !== undefined) node.value = String(el.value).slice(0, 80);
            }
            OUT.push(node);
          }
          for (const child of el.children) walk(child, keeping ? depth + 1 : depth);
        };
        if (document.body) walk(document.body, 0);
        return { url: location.href, title: document.title, count: OUT.length, nodes: OUT };
      })()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * 整页截图。
     * webview 的 capturePage 只截当前视口，所以一屏一屏滚着拍，
     * 拍完在 canvas 上按原位置拼回整页。页头固定栏每屏都会出现，
     * 拼接处会留下重复的横条，这是这种做法的固有代价。
     */
    function loadImageFromUrl(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('截图数据无法解码'));
        img.src = src;
      });
    }

    async function shotFullFrame(maxHeight) {
      const picked = lastFrame();
      if (picked.error) return picked;
      const frame = picked.frame;
      if (frame.tagName !== 'WEBVIEW' || typeof frame.capturePage !== 'function') {
        return { error: '当前是 Web 版（iframe 渲染），没有整页截图接口。桌面版可用。' };
      }
      const ready = await waitWebviewReady(frame);
      if (!ready) return { error: 'webview 尚未就绪（页面还在加载），稍后重试' };
      let metrics;
      try {
        metrics = await frame.executeJavaScript(`(() => ({
          height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
          viewport: window.innerHeight,
          width: window.innerWidth,
          dpr: window.devicePixelRatio || 1,
          y: Math.round(window.scrollY),
        }))()`, true);
      } catch (e) {
        return { error: '读取页面尺寸失败: ' + String(e && e.message) };
      }
      const limit = Number(maxHeight) > 0 ? Number(maxHeight) : 20000;
      const total = Math.min(metrics.height, limit);
      const truncated = metrics.height > limit;
      const step = Math.max(200, metrics.viewport - 40);
      const pages = Math.max(1, Math.ceil(total / step));
      try {
        let canvas = null;
        let painter = null;
        for (let i = 0; i < pages; i++) {
          const y = Math.min(i * step, Math.max(0, total - metrics.viewport));
          await frame.executeJavaScript('window.scrollTo(0, ' + y + '); 1', true);
          await new Promise((resolve) => setTimeout(resolve, 320));
          const native = await captureNative(frame);
          const img = await loadImageFromUrl(native.toDataURL());
          if (canvas === null) {
            canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = Math.min(Math.round(total * metrics.dpr), img.height * pages);
            painter = canvas.getContext('2d');
          }
          painter.drawImage(img, 0, Math.round(y * metrics.dpr));
        }
        await frame.executeJavaScript('window.scrollTo(0, ' + Math.round(metrics.y) + '); 1', true);
        const dataUrl = canvas.toDataURL('image/png');
        const j = await fetch('/rightbar-api/shot', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dataUrl, ext: 'png', kind: 'full' }),
        }).then((r) => r.json()).catch(() => null);
        if (j && j.ok) return { ok: true, path: j.path, bytes: j.bytes, pages, truncated, height: total };
        return { error: '整页截图存盘失败: ' + ((j && j.error) || '端点无响应') };
      } catch (e) {
        return { error: '整页截图失败: ' + String(e && e.message) };
      }
    }

    /**
     * 结构化提取。
     * 给条目选择器和字段映射，把整块列表整理成数组。
     * 字段写法："css" 取文字、"css@href" 取属性、"" 取整项文字。
     */
    function scrapeInFrame(opts) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const spec = {
        item: String(opts.item || ''),
        fields: opts.fields && typeof opts.fields === 'object' ? opts.fields : {},
        limit: typeof opts.limit === 'number' && opts.limit > 0 ? Math.min(opts.limit, 200) : 50,
      };
      if (spec.item === '') return Promise.resolve({ error: '要给条目的选择器，例如 .result-item' });
      if (Object.keys(spec.fields).length === 0) return Promise.resolve({ error: '要给字段映射，例如 {"标题": ".title", "链接": "a@href"}' });
      const script = `(() => {
        const spec = ${JSON.stringify(spec)};
        const nodes = Array.from(document.querySelectorAll(spec.item)).slice(0, spec.limit);
        if (nodes.length === 0) return { empty: '没有匹配到条目，选择器可能不对: ' + spec.item };
        const pick = (root, rule) => {
          const text = String(rule);
          const at = text.lastIndexOf('@');
          let sel = text;
          let attr = '';
          if (at > 0) { sel = text.slice(0, at); attr = text.slice(at + 1); }
          // 先看根节点自身是否匹配，再看后代。
          // querySelector 只搜后代不搜自身；而「条目选择器 == 字段选择器」
          // （例如 item='a' 配字段 'a@href'，即提取页面所有链接）是最常见用法，
          // 漏掉自身匹配会让这种用法的字段全为空（2026-10-26 实测复现并修复）。
          let el = null;
          if (sel === '' || sel === '.' || sel === 'self') el = root;
          else {
            try { if (root.matches && root.matches(sel)) el = root; } catch { /* 选择器不合法就只走后代 */ }
            if (el === null) el = root.querySelector(sel);
          }
          if (el === null) return '';
          if (attr === 'href') return el.getAttribute('href') || el.href || '';
          if (attr === 'src') return el.getAttribute('src') || el.src || '';
          if (attr !== '') return el.getAttribute(attr) || '';
          return (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 500);
        };
        const rows = nodes.map((node, index) => {
          const row = { _index: index };
          for (const key of Object.keys(spec.fields)) row[key] = pick(node, spec.fields[key]);
          return row;
        });
        return { url: location.href, count: rows.length, rows };
      })()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * 下载文件。
     * 先用页面自己的身份去取字节（带着登录态），拿到之后发宿主落盘；
     * 被跨域限制拦住就退回浏览器原生下载，文件进系统下载目录。
     */
    function downloadInFrame(opts) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const frame = picked.frame;
      const ref = String(opts.ref || '');
      const name = String(opts.name || '');
      const urlPromise = ref === ''
        ? Promise.resolve(String(opts.url || ''))
        : runInFrame(frame, `(() => {
            const el = document.querySelector(${JSON.stringify(refToSelector(ref))});
            if (el === null) return '';
            return el.getAttribute('href') || el.href || el.getAttribute('src') || el.src || '';
          })()`);
      return urlPromise.then(async (url) => {
        if (typeof url !== 'string' || url === '') return { error: '要给出网址 url，或给出页面上下载链接的 ref' };
        const script = `(async () => {
          const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
          if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
          const buf = await r.arrayBuffer();
          if (buf.byteLength > 60 * 1024 * 1024) return { ok: false, error: '文件超过 60MB，不在插件里转存' };
          const bytes = new Uint8Array(buf);
          let bin = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
          const fallback = new URL(${JSON.stringify(url)}).pathname.split('/').filter(Boolean).pop() || 'download.bin';
          return { ok: true, base64: btoa(bin), name: ${JSON.stringify(name)} || fallback };
        })()`;
        const got = await runInFrame(frame, script);
        if (got && got.ok && got.base64) {
          const j = await fetch('/rightbar-api/file', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ base64: got.base64, name: got.name }),
          }).then((r) => r.json()).catch(() => null);
          if (j && j.ok) return { ok: true, path: j.path, bytes: j.bytes };
          return { error: '文件存盘失败: ' + ((j && j.error) || '端点无响应') };
        }
        if (frame.tagName === 'WEBVIEW' && typeof frame.downloadURL === 'function') {
          try {
            frame.downloadURL(url);
            return { ok: true, via: 'webview.downloadURL', note: '页面请求被跨域限制拦住，已交给浏览器原生下载，文件会进系统的下载目录' };
          } catch (e) {
            return { error: '原生下载也失败: ' + String(e && e.message) };
          }
        }
        return got || { error: '下载失败' };
      });
    }

    /**
     * 按坐标点击。
     * 桌面版发真实鼠标事件，能点到画布、地图、自绘控件这类没法用选择器定位的东西。
     * 坐标是页面视口内的像素，左上角为 0,0。
     */
    function clickAtInFrame(x, y) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const frame = picked.frame;
      const px = Number(x);
      const py = Number(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) return Promise.resolve({ error: '要给数字坐标 x 和 y' });
      if (frame.tagName === 'WEBVIEW' && typeof frame.sendInputEvent === 'function') {
        try {
          try { frame.focus(); } catch { /* 不可聚焦时忽略 */ }
          frame.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
          frame.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
          return Promise.resolve({ ok: true, via: 'sendInputEvent', x: px, y: py });
        } catch (e) {
          return Promise.resolve({ error: '坐标点击失败: ' + String(e && e.message) });
        }
      }
      const script = `(() => {
        const el = document.elementFromPoint(${px}, ${py});
        if (el === null) return { ok: false, error: '这个坐标上没有元素' };
        el.click();
        return { ok: true, tag: el.tagName, text: (el.innerText || '').trim().slice(0, 40) };
      })()`;
      return runInFrame(frame, script);
    }

    /**
     * 整段文字输入。
     * 桌面版优先用 webview 自带的 insertText（真实输入，中文和符号都行）；
     * 没有这个接口时退回逐字 char 事件。输入前可以指定 ref 先聚焦。
     */
    async function typeInFrame(opts) {
      const picked = lastFrame();
      if (picked.error) return picked;
      const frame = picked.frame;
      const text = String(opts.text === undefined ? '' : opts.text);
      if (text === '') return { error: '要输入的文字是空的' };
      if (opts.ref) {
        const focused = await actInFrame('focus', opts.ref);
        if (focused && focused.error) return focused;
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (frame.tagName === 'WEBVIEW') {
        const ready = await waitWebviewReady(frame);
        if (!ready) return { error: 'webview 尚未就绪（页面还在加载），稍后重试' };
        try {
          try { frame.focus(); } catch { /* 忽略 */ }
          if (typeof frame.insertText === 'function') {
            frame.insertText(text);
            return { ok: true, via: 'insertText', chars: Array.from(text).length };
          }
          for (const ch of Array.from(text)) {
            frame.sendInputEvent({ type: 'char', keyCode: ch });
          }
          return { ok: true, via: 'char-events', chars: Array.from(text).length };
        } catch (e) {
          return { error: '文字输入失败: ' + String(e && e.message) };
        }
      }
      const script = `(() => {
        const el = document.activeElement;
        if (el === null || el === document.body) return { ok: false, error: '页面里没有聚焦的输入位置，先点一下输入框' };
        const text = ${JSON.stringify(text)};
        let inserted = false;
        try { inserted = document.execCommand('insertText', false, text); } catch (e) { inserted = false; }
        if (!inserted) {
          if (el.isContentEditable) el.innerText = (el.innerText || '') + text;
          else if ('value' in el) el.value = (el.value || '') + text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return { ok: true, via: inserted ? 'insertText' : 'value', chars: Array.from(text).length };
      })()`;
      return runInFrame(frame, script);
    }

    /**
     * 按选择器、ref 或标签文字直接设值，也可以清空。
     * 用原生 setter 写值再派发 input/change，这样 React 这类框架也认。
     */
    function setValueInFrame(opts) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const spec = {
        ref: String(opts.ref || ''),
        selector: String(opts.selector || ''),
        text: String(opts.text || ''),
        value: opts.value === undefined ? '' : String(opts.value),
        clear: opts.clear === true,
      };
      if (spec.ref === '' && spec.selector === '' && spec.text === '') {
        return Promise.resolve({ error: '要给出 ref、selector 或 text 三者之一来定位控件' });
      }
      const script = `(() => {
        const spec = ${JSON.stringify(spec)};
        let el = null;
        if (spec.ref !== '') {
          el = document.querySelector('[data-dsh-ref="' + spec.ref + '"]') || document.querySelector(spec.ref);
        } else if (spec.selector !== '') {
          el = document.querySelector(spec.selector);
        } else {
          const labelOf = (node) => {
            const aria = node.getAttribute('aria-label');
            if (aria) return aria;
            const wrap = node.closest ? node.closest('label') : null;
            if (wrap) return wrap.innerText || '';
            if (node.id) {
              const lab = document.querySelector('label[for="' + node.id.replace(/"/g, '\\\\"') + '"]');
              if (lab) return lab.innerText || '';
            }
            return (node.getAttribute('placeholder') || '') + ' ' + (node.getAttribute('name') || '');
          };
          for (const cand of document.querySelectorAll('input, textarea, select, [contenteditable=true]')) {
            if (labelOf(cand).includes(spec.text)) { el = cand; break; }
          }
        }
        if (el === null) return { ok: false, error: '没找到目标控件' };
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (spec.clear && (type === 'checkbox' || type === 'radio')) {
          if (el.checked) el.click();
          return { ok: true, cleared: true, checked: el.checked };
        }
        const want = spec.clear ? '' : spec.value;
        el.focus();
        if (el.isContentEditable) {
          el.innerText = want;
        } else if (el.tagName === 'SELECT') {
          el.value = want;
        } else {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && desc.set) desc.set.call(el, want); else el.value = want;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, cleared: spec.clear, value: el.value === undefined ? want : el.value, tag: el.tagName };
      })()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * Cookie 读写。
     * 读的是页面能看到的 Cookie（HttpOnly 的那些浏览器不给脚本，读不到就是读不到）。
     * 写的时候按 name=value、path=/ 逐个落。
     */
    function cookiesInFrame(how, cookies) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      if (how === 'set') {
        const list = Array.isArray(cookies) ? cookies : [];
        if (list.length === 0) return Promise.resolve({ error: '要给出要写入的 cookie 列表' });
        const script = `(() => {
          const list = ${JSON.stringify(list)};
          let set = 0;
          for (const item of list) {
            try {
              document.cookie = encodeURIComponent(String(item.name)) === String(item.name)
                ? String(item.name) + '=' + String(item.value) + '; path=/'
                : String(item.name) + '=' + String(item.value) + '; path=/';
              set += 1;
            } catch (e) { /* 单条失败继续 */ }
          }
          return { ok: true, set };
        })()`;
        return runInFrame(picked.frame, script);
      }
      const script = `(() => ({
        url: location.href,
        origin: location.origin,
        cookies: document.cookie.split('; ').filter((x) => x !== '').map((kv) => {
          const i = kv.indexOf('=');
          return i < 0 ? { name: kv, value: '' } : { name: kv.slice(0, i), value: kv.slice(i + 1) };
        }),
      }))()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * 重建浏览器会话。
     * 页面卡死、崩溃或者状态被弄脏时，把所有浏览器标签关掉再开一个新的。
     * 走的是官方 closeTab 与 openTab，不碰别的插件与别的标签类型。
     */
    async function sessionReset(ctx, url) {
      const sr = ctx.sidebarRight;
      if (sr === undefined || typeof sr.openTab !== 'function') return { error: 'sidebarRight 服务不可用' };
      let closed = 0;
      try {
        const need = sr.require();
        const snapshot = sr.openTabs && typeof sr.openTabs.getSnapshot === 'function' ? sr.openTabs.getSnapshot() : [];
        for (const tab of Array.isArray(snapshot) ? snapshot : []) {
          try {
            need.actions.closeTab(need.sessionId, tab.tabId);
            closed += 1;
          } catch { /* 单个标签关不掉继续 */ }
        }
      } catch (e) {
        return { error: '关闭旧标签失败: ' + String(e && e.message) };
      }
      await new Promise((resolve) => setTimeout(resolve, 600));
      const opened = await openBrowserTab(ctx, url || 'about:blank');
      if (opened && opened.error) return { error: '重开标签失败: ' + opened.error, closed };
      return { ok: true, closed, frames: opened && opened.frames, note: opened && opened.note };
    }

    /**
     * 内容导出。
     * markdown 按标题、段落、列表、链接、表格转义；html 去掉脚本与样式；
     * json 给出标题、大纲与链接清单；text 就是正文。
     */
    function contentInFrame(format, maxChars) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const fmt = ['markdown', 'html', 'text', 'json'].indexOf(String(format)) >= 0 ? String(format) : 'markdown';
      const limit = typeof maxChars === 'number' && maxChars > 0 ? Math.min(maxChars, 200000) : 20000;
      const script = `(() => {
        const fmt = ${JSON.stringify(fmt)};
        const limit = ${limit};
        const clean = (html) => html
          .replace(/<script[\\s\\S]*?<\\/script>/gi, '')
          .replace(/<style[\\s\\S]*?<\\/style>/gi, '')
          .replace(/<noscript[\\s\\S]*?<\\/noscript>/gi, '')
          .replace(/<svg[\\s\\S]*?<\\/svg>/gi, '');
        if (fmt === 'html') {
          const html = clean(document.body ? document.body.innerHTML : '');
          return { format: 'html', url: location.href, content: html.slice(0, limit), truncated: html.length > limit };
        }
        if (fmt === 'text') {
          const text = document.body ? document.body.innerText : '';
          return { format: 'text', url: location.href, content: text.slice(0, limit), truncated: text.length > limit };
        }
        if (fmt === 'json') {
          const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 200).map((h) => ({ level: Number(h.tagName.slice(1)), text: (h.innerText || '').trim().slice(0, 200) }));
          const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 300).map((a) => ({ text: (a.innerText || '').trim().slice(0, 100), href: a.href }));
          return { format: 'json', url: location.href, title: document.title, headings, links, truncated: false };
        }
        const out = [];
        const walk = (node) => {
          if (node.nodeType === 3) {
            const t = (node.textContent || '').replace(/\\s+/g, ' ');
            if (t.trim() !== '') out.push(t);
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = node.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg', 'template', 'iframe'].indexOf(tag) >= 0) return;
          if (/^h[1-6]$/.test(tag)) { out.push('\\n' + '#'.repeat(Number(tag[1])) + ' ' + (node.innerText || '').trim() + '\\n'); return; }
          if (tag === 'p') { out.push('\\n' + (node.innerText || '').trim() + '\\n'); return; }
          if (tag === 'br') { out.push('  \\n'); return; }
          if (tag === 'a' && node.getAttribute('href')) { out.push('[' + (node.innerText || '').trim() + '](' + node.href + ')'); return; }
          if (tag === 'img') { out.push('![' + (node.getAttribute('alt') || '') + '](' + node.src + ')'); return; }
          if (tag === 'li') { out.push('\\n- ' + (node.innerText || '').trim()); return; }
          if (tag === 'tr') {
            const cells = Array.from(node.children).map((c) => (c.innerText || '').trim().replace(/\\|/g, '\\\\|'));
            out.push('\\n| ' + cells.join(' | ') + ' |');
            return;
          }
          for (const child of node.childNodes) walk(child);
        };
        if (document.body) walk(document.body);
        const text = out.join('').replace(/\\n{3,}/g, '\\n\\n').trim();
        return { format: 'markdown', url: location.href, title: document.title, content: text.slice(0, limit), truncated: text.length > limit };
      })()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * 浏览器兜底搜索。
     * 自建搜索与接口都不可用时，用右推栏里的真浏览器打开搜索页，把结果标题和链接读回来。
     * 反爬拦不住真实浏览器；代价是慢，而且右推栏会亮一下。
     */
    async function webSearchInBrowser(ctx, query, limit) {
      const text = String(query || '').trim();
      if (text === '') return { error: '搜索词是空的' };
      const engines = [
        (q) => 'https://www.sogou.com/web?query=' + encodeURIComponent(q),
        (q) => 'https://www.so.com/s?q=' + encodeURIComponent(q),
        (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q),
      ];
      const probe = '(() => Array.from(document.querySelectorAll("h3 a")).map((a) => ({ title: (a.innerText || "").trim(), url: a.href || "" })).filter((x) => x.title !== "" && /^https?:/.test(x.url)).slice(0, 30))()';
      const want = typeof limit === 'number' && limit > 0 ? Math.min(limit, 20) : 8;
      for (const build of engines) {
        const target = build(text);
        const opened = await openBrowserTab(ctx, target);
        if (opened && opened.error) continue;
        const started = Date.now();
        let rows = [];
        while (Date.now() - started < 10000) {
          await new Promise((resolve) => setTimeout(resolve, 700));
          const picked = lastFrame();
          if (picked.error) continue;
          const got = await runInFrame(picked.frame, probe);
          if (Array.isArray(got) && got.length >= 3) { rows = got; break; }
        }
        if (rows.length === 0) continue;
        const seen = new Set();
        const sources = [];
        for (const row of rows) {
          if (seen.has(row.url)) continue;
          seen.add(row.url);
          sources.push({ url: row.url, title: row.title });
          if (sources.length >= want) break;
        }
        if (sources.length > 0) return { ok: true, sources, via: target, truncated: rows.length > sources.length };
      }
      return { error: '三个搜索引擎都没能取到结果（可能遇到验证页）' };
    }

    /** 在页面里执行任意脚本。返回值原样带回，非 JSON 可序列化时退化为字符串。 */
    function evalInFrame(script) {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      return runInFrame(picked.frame, script).then((r) => {
        if (r && r.error) return r;
        return { ok: true, result: r };
      });
    }

    /** 页面当前状况：地址、标题、加载状态、滚动位置、整页高度。 */
    function pageInfo() {
      const picked = lastFrame();
      if (picked.error) return Promise.resolve(picked);
      const script = `(() => ({
        url: location.href,
        title: document.title,
        ready: document.readyState,
        scrollY: Math.round(window.scrollY),
        pageHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        frames: window.frames.length,
      }))()`;
      return runInFrame(picked.frame, script);
    }

    /**
     * 标签页账目。
     * 官方 sidebarRight.openTabs 是标签元数据的快照源，元素含 sessionId/tabId/kind。
     * 关闭走官方 actions.closeTab（官方自己的 removeAfterCleanup 就是这条路）。
     * 切换没有公开方法，按官方标签元素上的 data-sidebar-right-tab 标记点一下。
     */
    function tabsAction(ctx, action, tabId) {
      const sr = ctx.sidebarRight;
      if (sr === undefined) return Promise.resolve({ error: 'sidebarRight 服务不可用' });
      const list = () => {
        try {
          const snap = sr.openTabs && typeof sr.openTabs.getSnapshot === 'function' ? sr.openTabs.getSnapshot() : [];
          return Array.isArray(snap) ? snap : [];
        } catch { return []; }
      };
      if (action === 'list') {
        const tabs = list().map((t) => ({ tabId: t.tabId, kind: t.kind, sessionId: t.sessionId, title: t.title }));
        return Promise.resolve({ ok: true, tabs, count: tabs.length });
      }
      if (!tabId) return Promise.resolve({ error: '缺少 tabId，先调 rightbar_tabs 看清单' });
      if (action === 'close') {
        try {
          const need = sr.require();
          if (need === undefined || need.actions === undefined) return Promise.resolve({ error: '当前没有会话面，无法关闭标签' });
          need.actions.closeTab(need.sessionId, tabId);
          return Promise.resolve({ ok: true, via: 'actions.closeTab', tabId });
        } catch (e) {
          return Promise.resolve({ error: '关闭标签失败: ' + String(e && e.message) });
        }
      }
      if (action === 'switch') {
        const el = document.querySelector(`[data-sidebar-right-tab="${tabId}"], [data-dockkit-tab="${tabId}"]`);
        if (el === null) return Promise.resolve({ error: '页面上找不到这个标签的入口，可能已被关闭' });
        el.click();
        return Promise.resolve({ ok: true, via: 'tab.click', tabId });
      }
      return Promise.resolve({ error: '未知的标签操作: ' + action });
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
                case 'wait': value = await waitInFrame(cmd); break;
                case 'select': value = await selectInFrame(cmd.ref, cmd.value); break;
                case 'check': value = await checkInFrame(cmd.ref, cmd.checked); break;
                case 'scroll': value = await scrollInFrame(cmd); break;
                case 'history': value = await historyAction(cmd.how); break;
                case 'eval': value = await evalInFrame(cmd.script); break;
                case 'info': value = await pageInfo(); break;
                case 'zoom': value = await zoomFrame(cmd.factor); break;
                case 'resize': value = await resizeFrame(cmd.spec); break;
                case 'find': value = await findInFrame(cmd.text, cmd.forward); break;
                case 'pdf': value = await pdfFrame(); break;
                case 'style': value = await styleFrame(cmd.css, cmd.key); break;
                case 'health': value = await frameHealth(cmd.how, cmd.muted); break;
                case 'key': value = await pressKeyInFrame(cmd); break;
                case 'controls': value = await controlsInFrame(); break;
                case 'captcha': value = await captchaInFrame(); break;
                case 'a11y': value = await a11yInFrame(); break;
                case 'shotfull': value = await shotFullFrame(cmd.maxHeight); break;
                case 'scrape': value = await scrapeInFrame(cmd); break;
                case 'download': value = await downloadInFrame(cmd); break;
                case 'clickat': value = await clickAtInFrame(cmd.x, cmd.y); break;
                case 'type': value = await typeInFrame(cmd); break;
                case 'setvalue': value = await setValueInFrame(cmd); break;
                case 'cookies': value = await cookiesInFrame(cmd.how, cmd.cookies); break;
                case 'sessionreset': value = await sessionReset(ctx, cmd.url); break;
                case 'content': value = await contentInFrame(cmd.format, cmd.maxChars); break;
                case 'searchweb': value = await webSearchInBrowser(ctx, cmd.query, cmd.limit); break;
                case 'tabs': value = await tabsAction(ctx, cmd.how, cmd.tabId); break;
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
