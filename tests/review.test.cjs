const assert = require("node:assert/strict");
const test = require("node:test");

const plugin = require("../index.cjs");
const rooms = require("../rooms.cjs");

const scripts = {
  "main.bls": [
    { kind: "say", text: "主课第一句" },
    { kind: "boardBlock", lines: ["# 板书"] },
    { kind: "say", text: "主课第二句" },
    { kind: "say", text: "主课第三句" },
  ],
  "aside.bls": [
    { kind: "say", text: "插话第一句" },
    { kind: "say", text: "插话第二句" },
  ],
};

function layer(file, id, conversationId) {
  return rooms.makeLayer({ id, file, conversationId, steps: scripts[file] });
}

test("回看只含当前已展示 BLS 的 say，插话返回后恢复原层且可持久化", async () => {
  const handlers = new Map();
  const saved = new Map();
  try {
    await plugin.register({
      registerTool() {},
      registerPromptProvider() {},
      registerIpc: (name, handler) => handlers.set(name, handler),
      events: { on() {} },
      onDispose() {},
      log() {},
      storage: { get: (key) => saved.get(key), set: (key, value) => saved.set(key, value) },
    });
    const room = rooms.ensureRoom("review-test");
    const read = () => handlers.get("review")({ conversationId: room.conversationId });
    rooms.pushLayer(room, layer("main.bls", "main", room.conversationId), "append");

    assert.deepEqual(read().says, []);
    rooms.advance(room);
    assert.deepEqual(read().says, ["主课第一句"]);
    rooms.pushLayer(room, layer("aside.bls", "aside", room.conversationId), "interrupt");
    rooms.advance(room); // 进入插话的过渡帧仍属已展示的主课
    assert.deepEqual(read().says, ["主课第一句"]);
    rooms.advance(room);
    assert.deepEqual(read(), { ok: true, file: "aside.bls", says: ["插话第一句"] });
    rooms.advance(room);
    assert.deepEqual(read().says, ["插话第一句", "插话第二句"]);
    rooms.advance(room); // 返回主课的过渡帧仍显示插话
    assert.deepEqual(read().says, ["插话第一句", "插话第二句"]);
    rooms.advance(room); // 主课的板书 step：先恢复主课已说过的第一句
    assert.deepEqual(read(), { ok: true, file: "main.bls", says: ["主课第一句"] });
    rooms.advance(room);
    assert.deepEqual(read().says, ["主课第一句", "主课第二句"]);

    const snapshot = rooms.serializeRooms();
    assert.deepEqual(snapshot[room.conversationId].review, {
      file: "main.bls", says: ["主课第一句", "主课第二句"],
    });
    rooms.clearAll();
    rooms.restoreRooms(snapshot, (restored, entry, index) => layer(
      entry.file, `restored-${index}`, restored.conversationId,
    ));
    assert.deepEqual(handlers.get("review")({ conversationId: "review-test" }).says,
      ["主课第一句", "主课第二句"]);

    const restored = rooms.getRoom("review-test");
    rooms.advance(restored);
    assert.deepEqual(restored.review.says, ["主课第一句", "主课第二句", "主课第三句"]);
    rooms.replayLayer(restored, layer("main.bls", "replay", restored.conversationId));
    assert.deepEqual(handlers.get("review")({ conversationId: "review-test" }).says, []);
    rooms.advance(restored);
    assert.deepEqual(restored.review.says, ["主课第一句"]);
    rooms.replayAll(restored, [layer("main.bls", "replay-all", restored.conversationId)]);
    assert.deepEqual(restored.review.says, []);
    rooms.advance(restored);
    rooms.clearRoom(restored);
    assert.deepEqual(handlers.get("review")({ conversationId: "review-test" }).says, []);
  } finally {
    plugin.unregister();
  }
});
