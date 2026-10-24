const assert = require("node:assert/strict");
const test = require("node:test");

const plugin = require("../index.cjs");
const rooms = require("../rooms.cjs");

test("最后一步已展示但尚未弹栈时，Provider 和 status 报告本层完成", async () => {
  const tools = new Map();
  let provider;
  try {
    await plugin.register({
      registerTool: (tool) => tools.set(tool.id, tool),
      registerPromptProvider: (item) => { provider = item; },
      registerIpc() {},
      events: { on() {} },
      onDispose() {},
      log() {},
    });

    const room = rooms.ensureRoom("completed-progress-test");
    rooms.pushLayer(room, rooms.makeLayer({
      id: "lesson",
      conversationId: room.conversationId,
      file: "lesson.bls",
      steps: [{ kind: "say", text: "第一步" }, { kind: "say", text: "最后一步" }],
    }), "interrupt");
    const context = { conversationId: room.conversationId, userText: "追问" };
    const status = tools.get("better-lessons_status").execute;

    assert.match(provider.provide(context), /正在播放《lesson\.bls》第 1\/2 步/);
    assert.match(await status({}, context), /正在播放：《lesson\.bls》第 1\/2 步/);

    rooms.advance(room);
    assert.match(provider.provide(context), /正在播放《lesson\.bls》第 2\/2 步/);

    rooms.advance(room);
    assert.equal(room.frames[0].layer.cursor, 2);
    assert.match(provider.provide(context), /《lesson\.bls》已完成 2\/2 步，等待点击切换/);
    assert.match(await status({}, context), /本层进度：《lesson\.bls》已完成 2\/2 步，等待点击切换/);
    assert.doesNotMatch(provider.provide(context), /第 3\/2 步/);
    assert.doesNotMatch(await status({}, context), /第 3\/2 步/);
  } finally {
    plugin.unregister();
  }
});
