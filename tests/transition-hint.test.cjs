const assert = require("node:assert/strict");
const test = require("node:test");

const rooms = require("../rooms.cjs");

function layer(id, transitionHint = "") {
  return rooms.makeLayer({
    id,
    conversationId: "transition-hint-test",
    file: `${id}.bls`,
    steps: [{ kind: "say", text: id }],
    transitionHint,
  });
}

test("transitionHint 只在补充层结束、返回被打断层时显示", () => {
  const room = rooms.ensureRoom("transition-hint-test");
  try {
    rooms.pushLayer(room, layer("original"), "interrupt");
    rooms.pushLayer(room, layer("supplement", "我们回到刚才那道题。"), "interrupt");

    const entering = rooms.advance(room);
    assert.equal(entering.kind, "transition");
    assert.equal(entering.transition.kind, "in");
    assert.equal(entering.transition.text, "先看一个补充。");

    assert.equal(rooms.advance(room).file, "supplement.bls");
    const returning = rooms.advance(room);
    assert.equal(returning.kind, "transition");
    assert.equal(returning.transition.kind, "out");
    assert.equal(returning.transition.text, "我们回到刚才那道题。");
    assert.equal(rooms.advance(room).file, "original.bls");
  } finally {
    rooms.clearAll();
  }
});

test("没有 transitionHint 时返回过渡帧仍使用默认文案", () => {
  const room = rooms.ensureRoom("transition-hint-test");
  try {
    rooms.pushLayer(room, layer("original"), "interrupt");
    rooms.pushLayer(room, layer("supplement"), "interrupt");

    assert.equal(rooms.advance(room).transition.text, "先看一个补充。");
    rooms.advance(room);
    assert.equal(rooms.advance(room).transition.text, "好，我们回到刚才那里。");
  } finally {
    rooms.clearAll();
  }
});
