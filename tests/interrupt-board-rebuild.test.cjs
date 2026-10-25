const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const rooms = require("../rooms.cjs");

function windowFrameHarness() {
  const html = fs.readFileSync(path.join(__dirname, "..", "ui.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const start = script.indexOf("function applyFrame(result) {");
  const end = script.indexOf("async function advance() {", start);
  assert.ok(start >= 0 && end > start);
  const source = `
    let boardLines = [];
    let boardSource = "";
    let currentFile = null;
    let idleEmpty = false;
    const renders = [];
    const dialogs = [];
    const titlebarTitle = { textContent: "" };
    function renderBoard(text, hint) {
      boardSource = text;
      boardLines = text.split("\\n");
      renders.push({ text, hint });
    }
    function setDialog(text) { dialogs.push(text); }
    function setHint() {}
    function leaveIdle() {}
    function playFigure() {}
    function stageOf() { return { slot: "talk" }; }
    function lineIndexOf() { return 0; }
    ${script.slice(start, end)}
    ({ applyFrame, renders, dialogs, board: () => boardSource });
  `;
  return vm.runInNewContext(source);
}

function makeLayer(room, id, steps) {
  return rooms.makeLayer({ id, conversationId: room.conversationId, file: `${id}.bls`, steps });
}

for (const nextStep of [
  { kind: "say", text: "变化量用一阶导数近似，再乘上 dx" },
  { kind: "boardBlock", lines: ["## 继续写"] },
]) {
  test(`插话结束后续播 ${nextStep.kind} 时先恢复原板书`, () => {
    const ui = windowFrameHarness();
    const room = rooms.ensureRoom(`interrupt-rebuild-${nextStep.kind}`);
    try {
      rooms.pushLayer(room, makeLayer(room, "02", [
        { kind: "boardBlock", lines: ["# 02 的板书"] },
        nextStep,
      ]), "interrupt");
      ui.applyFrame(rooms.advance(room));
      rooms.pushLayer(room, makeLayer(room, "03", [
        { kind: "boardBlock", lines: ["# 03 的板书"] },
      ]), "interrupt");
      ui.applyFrame(rooms.advance(room)); // 进入 03：清板
      ui.applyFrame(rooms.advance(room)); // 03 的板书
      ui.applyFrame(rooms.advance(room)); // 回到 02：清板
      assert.equal(ui.board(), "");

      const resumed = rooms.advance(room);
      assert.equal(resumed.boardTextBeforeStep, "# 02 的板书");
      const renderCount = ui.renders.length;
      ui.applyFrame(resumed);
      assert.equal(ui.renders[renderCount].text, "# 02 的板书");
      assert.equal(ui.renders[renderCount].hint, null);
      assert.equal(ui.board(), resumed.boardText);
      if (nextStep.kind === "say") {
        assert.equal(ui.renders.length, renderCount + 1);
        assert.equal(ui.dialogs.at(-1), nextStep.text);
      } else {
        assert.equal(ui.renders[renderCount + 1].hint.fromLine, 1);
      }
    } finally {
      rooms.dropRoom(room.conversationId);
    }
  });
}
