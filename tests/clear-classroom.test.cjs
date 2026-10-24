const assert = require("node:assert/strict");
const test = require("node:test");

const plugin = require("../index.cjs");
const rooms = require("../rooms.cjs");

test("清空当前课堂后不再播放旧帧，也不会从存档恢复旧播放列表", async () => {
  const handlers = new Map();
  const saved = new Map();
  let finishBinding;
  const binding = new Promise((resolve) => { finishBinding = resolve; });

  try {
    await plugin.register({
      registerTool() {},
      registerPromptProvider() {},
      registerIpc: (name, handler) => handlers.set(name, handler),
      events: { on() {} },
      onDispose() {},
      log() {},
      storage: {
        get: (key) => saved.get(key),
        set: (key, value) => saved.set(key, value),
      },
      deps: { workspace: { getBinding: () => binding } },
    });

    const active = rooms.ensureRoom("active");
    const other = rooms.ensureRoom("other");
    const make = (id, file) => rooms.makeLayer({
      id, conversationId: active.conversationId, file,
      steps: [{ kind: "boardBlock", lines: ["# 旧板书"] }, { kind: "say", text: "下一句" }],
    });
    rooms.pushLayer(active, make("one", "one.bls"), "append");
    rooms.pushLayer(active, make("two", "two.bls"), "append");
    active.lessonPaths["one.bls"] = "C:\\old\\one.bls";
    rooms.advance(active);
    rooms.pushLayer(other, rooms.makeLayer({
      id: "other", conversationId: other.conversationId, file: "other.bls",
      steps: [{ kind: "say", text: "另一间课堂" }],
    }), "append");

    assert.equal(active.frames.length, 2);
    assert.match(active.board.lines.join("\n"), /旧板书/);

    const pendingReplay = handlers.get("replay-all")({ conversationId: "active" });
    const cleared = handlers.get("clear-classroom")({ conversationId: "active" });
    finishBinding(null);

    assert.deepEqual(cleared, { ok: true, boardText: "" });
    assert.equal((await pendingReplay).canceled, true);
    assert.equal(rooms.advance(active).kind, "done");
    assert.equal(active.frames.length, 0);
    assert.deepEqual(active.board.lines, []);
    assert.deepEqual(active.lessonFiles, []);
    assert.deepEqual(active.lessonPaths, {});
    assert.equal(other.frames.length, 1);

    plugin.unregister(); // 关窗/停用会立即把去抖中的状态落盘
    assert.equal(saved.get("rooms").active, undefined);
    assert.deepEqual(saved.get("rooms").other.lessonFiles, ["other.bls"]);
  } finally {
    plugin.unregister();
  }
});
