const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("课堂窗口拒绝页面导航和新窗口，也不注册外部打开链接的 IPC", async () => {
  let win;
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      win = this;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => { this.windowOpenHandler = handler; };
      this.webContents.send = () => {};
    }
    isDestroyed() { return false; }
    async loadFile(file) {
      assert.equal(path.basename(file), "ui.html");
      assert.equal(this.webContents.listenerCount("will-navigate"), 1);
      assert.equal(this.webContents.listenerCount("will-frame-navigate"), 1);
      assert.equal(this.webContents.listenerCount("will-redirect"), 1);
      assert.equal(typeof this.windowOpenHandler, "function");
    }
    getNormalBounds() { return { x: 0, y: 0, width: 800, height: 600 }; }
    isMaximized() { return false; }
    close() { this.emit("closed"); }
  }
  const electron = {
    BrowserWindow,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1600, height: 900 } }) },
  };
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    return request === "electron" ? electron : originalLoad.call(this, request, parent, isMain);
  };
  let plugin;
  try {
    plugin = require("../index.cjs");
    const handlers = new Map();
    await plugin.register({
      registerTool() {},
      registerPromptProvider() {},
      registerIpc: (name, handler) => handlers.set(name, handler),
      events: { on() {} },
      onDispose() {},
      log() {},
    });
    await plugin.open();

    for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
      let prevented = false;
      win.webContents.emit(name, { preventDefault() { prevented = true; } }, "https://example.org/");
      assert.equal(prevented, true, `${name} 必须取消`);
    }
    assert.deepEqual(win.windowOpenHandler({ url: "https://example.org/" }), { action: "deny" });
    assert.equal(handlers.has("open-external"), false);
  } finally {
    if (plugin) plugin.unregister();
    Module._load = originalLoad;
  }
});

test("对白和板书的 Markdown 链接只保留可见文字，不生成可拖动的锚点", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "ui.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const start = script.indexOf("const md = window.markdownit(");
  const end = script.indexOf("\n    /**\n     * 给块级元素", start);
  const renderStart = script.indexOf("function renderInline(source) {");
  const renderEnd = script.indexOf("\n    // ---------------------------------------------------------------- 视图", renderStart);
  assert.ok(start >= 0 && end > start && renderStart > end && renderEnd > renderStart);
  const { renderInline, renderBoardHtml, config } = vm.runInNewContext(
    script.slice(start, end) + script.slice(renderStart, renderEnd) +
      "\n;({ renderInline, renderBoardHtml, config: PURIFY_CONFIG })",
    { window: {
      markdownit: require("../vendor/markdown-it.min.js"),
      DOMPurify: { sanitize: (html) => html },
    } },
  );
  for (const render of [renderInline, renderBoardHtml]) {
    const output = render("[网页](https://example.org/) 和 [邮件](mailto:a@example.org) 与 [**加粗**](https://evil.test/)");
    assert.match(output, /网页/);
    assert.match(output, /邮件/);
    assert.match(output, /<strong>加粗<\/strong>/);
    assert.doesNotMatch(output, /<a\b|href=|https:\/\/example\.org|mailto:/i);
    const image = render("![替代文字](https://example.org/image.png)");
    assert.match(image, /替代文字/);
    assert.doesNotMatch(image, /<img\b|src=|https:\/\/example\.org/i);
  }
  assert.equal(renderInline("<https://example.org/>"), "https://example.org/");
  assert.equal(config.ALLOWED_TAGS.includes("a"), false);
  assert.equal(config.ALLOWED_ATTR.includes("href"), false);
  assert.doesNotMatch(script, /open-external|openMarkdownLink/);
});
