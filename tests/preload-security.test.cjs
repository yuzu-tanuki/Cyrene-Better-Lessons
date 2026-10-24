const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBridge() {
  const calls = [];
  const listeners = new Map();
  let exposed;
  const ipcRenderer = {
    invoke(channel, payload) {
      calls.push({ channel, payload });
      return Promise.resolve({ ok: true });
    },
    on(channel, listener) { listeners.set(channel, listener); },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel);
    },
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "preload.cjs"), "utf8");
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, "electron", "沙箱 preload 不应加载 Node 模块");
      return {
        contextBridge: { exposeInMainWorld(name, api) {
          assert.equal(name, "betterLessons");
          exposed = api;
        } },
        ipcRenderer,
      };
    },
  });
  return { bridge: exposed, calls, listeners, ipcRenderer };
}

test("preload 仅放行课堂必需通道并重建受限载荷", async () => {
  const { bridge, calls, ipcRenderer } = loadBridge();
  assert.deepEqual(Object.keys(bridge).sort(), ["invoke", "on"]);
  assert.notEqual(bridge, ipcRenderer);

  for (const name of ["state", "win-minimize", "win-maximize", "win-close"]) {
    await bridge.invoke(name);
    assert.equal(calls.at(-1).channel, `plugin:better-lessons:${name}`);
    assert.equal(calls.at(-1).payload, undefined);
  }
  for (const name of ["advance", "review", "clear-classroom", "pick-lesson", "replay-all"]) {
    await bridge.invoke(name, { conversationId: "A" });
    assert.equal(calls.at(-1).channel, `plugin:better-lessons:${name}`);
    assert.deepEqual({ ...calls.at(-1).payload }, { conversationId: "A" });
  }
  await bridge.invoke("replay", { conversationId: null, file: "课.bls" });
  assert.deepEqual({ ...calls.at(-1).payload }, { conversationId: null, file: "课.bls" });

  const before = calls.length;
  for (const [name, payload] of [
    ["open-window", undefined],
    ["lessons", { conversationId: "A" }],
    ["open-external", { url: "file:///C:/Windows/System32/calc.exe" }],
    ["__proto__", undefined],
    ["advance", { conversationId: "A", arbitrary: true }],
    ["replay", { conversationId: "A", file: "a.bls", command: "cmd" }],
    ["replay", { conversationId: "A", file: "a\0.bls" }],
    ["replay", { conversationId: "A", file: "../a.bls" }],
    ["replay", { conversationId: "A" }],
    ["advance", {}],
    ["advance", { conversationId: "A".repeat(513) }],
    ["advance", { conversationId: { nested: true } }],
    ["state", { conversationId: "A" }],
  ]) {
    await assert.rejects(bridge.invoke(name, payload));
  }
  assert.equal(calls.length, before, "非法请求不能抵达 ipcRenderer");
});

test("preload 事件订阅只交付 payload，不泄露 Electron 事件对象", () => {
  const { bridge, listeners } = loadBridge();
  assert.throws(() => bridge.on("other", () => {}), /未授权/);
  assert.throws(() => bridge.on("bind", null), /未授权/);
  assert.equal(listeners.size, 0);
  for (const name of ["bind", "push", "restore", "notice"]) {
    const payload = { text: name };
    const event = { sender: { send() { throw new Error("leaked"); } } };
    let received;
    const unsubscribe = bridge.on(name, (...args) => { received = args; });
    const channel = `plugin:better-lessons:${name}`;
    listeners.get(channel)(event, payload);
    assert.equal(received.length, 1);
    assert.equal(received[0], payload);
    unsubscribe();
    assert.equal(listeners.has(channel), false);
  }
});

test("课堂页面不再直接使用 Electron 或 Node API", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "ui.html"), "utf8");
  assert.doesNotMatch(html, /require\s*\(\s*["']electron["']\s*\)|\bipcRenderer\b/);
  assert.match(html, /const classroom = window\.betterLessons/);
});
