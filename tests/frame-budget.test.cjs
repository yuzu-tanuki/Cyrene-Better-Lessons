const assert = require("node:assert/strict");
const test = require("node:test");

const rooms = require("../rooms.cjs");

function layer(room, number) {
  return rooms.makeLayer({
    id: `layer-${number}`,
    conversationId: room.conversationId,
    file: `${number}.bls`,
    steps: [{ kind: "say", text: String(number) }],
  });
}

function files(room) {
  return room.frames.filter((frame) => frame.type === "layer").map((frame) => frame.layer.file);
}

test("append 超限时保留队首和刚推入的层，折叠较早的待播层", () => {
  try {
    const room = rooms.ensureRoom("frame-budget-append");
    for (let n = 1; n <= 9; n += 1) rooms.pushLayer(room, layer(room, n), "append");
    const result = rooms.pushLayer(room, layer(room, 10), "append");

    assert.deepEqual(result, { frameCount: 9, dropped: 1 });
    assert.deepEqual(files(room), ["1.bls", "3.bls", "4.bls", "5.bls", "6.bls",
      "7.bls", "8.bls", "9.bls", "10.bls"]);
  } finally {
    rooms.clearAll();
  }
});

test("interrupt 超限时保留刚推入的层，折叠最早的旧层", () => {
  try {
    const room = rooms.ensureRoom("frame-budget-interrupt");
    for (let n = 1; n <= 8; n += 1) rooms.pushLayer(room, layer(room, n), "interrupt");
    const result = rooms.pushLayer(room, layer(room, 9), "interrupt");

    assert.deepEqual(result, { frameCount: 9, dropped: 1 });
    assert.equal(room.frames[0].type, "transition");
    assert.equal(room.frames[1].layer.file, "9.bls");
    assert.ok(!files(room).includes("1.bls"));
  } finally {
    rooms.clearAll();
  }
});

test("混合推入和恢复后仍按推入顺序折叠", () => {
  try {
    const room = rooms.ensureRoom("frame-budget-mixed");
    rooms.pushLayer(room, layer(room, 1), "append", 4);
    rooms.pushLayer(room, layer(room, 2), "append", 4);
    rooms.pushLayer(room, layer(room, 3), "interrupt", 4);
    const first = rooms.pushLayer(room, layer(room, 4), "append", 4);
    assert.equal(first.dropped, 1);
    assert.deepEqual(files(room), ["3.bls", "2.bls", "4.bls"]);

    const snapshot = rooms.serializeRooms();
    rooms.clearAll();
    rooms.restoreRooms(snapshot, (restored, entry) => layer(restored, Number.parseInt(entry.file, 10)));
    const restored = rooms.getRoom("frame-budget-mixed");
    const second = rooms.pushLayer(restored, layer(restored, 5), "append", 4);
    assert.equal(second.dropped, 1);
    assert.deepEqual(files(restored), ["3.bls", "4.bls", "5.bls"]);

    // 升级旧版快照时没有 pushOrder，仍应保留新推入的层。
    snapshot[room.conversationId].frames.forEach((frame) => { delete frame.pushOrder; });
    rooms.clearAll();
    rooms.restoreRooms(snapshot, (legacy, entry) => layer(legacy, Number.parseInt(entry.file, 10)));
    const legacy = rooms.getRoom("frame-budget-mixed");
    assert.equal(rooms.pushLayer(legacy, layer(legacy, 5), "append", 4).dropped, 1);
    assert.deepEqual(files(legacy), ["3.bls", "4.bls", "5.bls"]);
  } finally {
    rooms.clearAll();
  }
});
