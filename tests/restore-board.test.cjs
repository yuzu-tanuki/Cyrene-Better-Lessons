const assert = require("node:assert/strict");
const test = require("node:test");

const rooms = require("../rooms.cjs");

const scripts = {
  "old.bls": [{ kind: "boardBlock", lines: ["# 旧板书"] }],
  "say.bls": [{ kind: "say", text: "新课开场" }],
  "board.bls": [{ kind: "boardBlock", lines: ["# 新板书"] }],
  "continued.bls": [
    { kind: "boardBlock", lines: ["# 新板书"] },
    { kind: "say", text: "继续讲解" },
  ],
};

function makeLayer(room, file) {
  return rooms.makeLayer({
    id: file,
    conversationId: room.conversationId,
    file,
    steps: scripts[file],
  });
}

function restore(snapshot) {
  rooms.clearAll();
  rooms.restoreRooms(snapshot, (room, entry) => makeLayer(room, entry.file));
  return rooms.getRoom("restore-board-test");
}

for (const [file, expectedAfterFirstStep] of [
  ["say.bls", ""],
  ["board.bls", "# 新板书"],
]) {
  test(`新层 ${file} 在第一步前恢复，不继承已结束层的板书`, () => {
    try {
      const room = rooms.ensureRoom("restore-board-test");
      rooms.pushLayer(room, makeLayer(room, "old.bls"), "append");
      rooms.advance(room);
      rooms.advance(room); // 弹出旧层；黑板仍留着旧内容
      assert.equal(room.frames.length, 0);
      assert.deepEqual(room.board.lines, ["# 旧板书"]);

      rooms.pushLayer(room, makeLayer(room, file), "interrupt");
      const snapshot = rooms.serializeRooms();
      assert.equal(snapshot[room.conversationId].frames[0].cursor, 0);
      assert.deepEqual(snapshot[room.conversationId].board, ["# 旧板书"]);

      const restored = restore(snapshot);
      assert.deepEqual(restored.board.lines, []); // 窗口恢复时立即展示空板
      assert.equal(restored.boardOwner, restored.frames[0].layer.id);
      assert.equal(rooms.advance(restored).boardText, expectedAfterFirstStep);
    } finally {
      rooms.clearAll();
    }
  });
}

test("恢复已播放的新层时按 cursor 重建板书", () => {
  try {
    const room = rooms.ensureRoom("restore-board-test");
    rooms.pushLayer(room, makeLayer(room, "continued.bls"), "append");
    rooms.advance(room);
    const snapshot = rooms.serializeRooms();
    snapshot[room.conversationId].board = ["# 旧板书"];

    const restored = restore(snapshot);
    assert.equal(restored.frames[0].layer.cursor, 1);
    assert.deepEqual(restored.board.lines, ["# 新板书"]);
    assert.equal(rooms.advance(restored).boardText, "# 新板书");
  } finally {
    rooms.clearAll();
  }
});
