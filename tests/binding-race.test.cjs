const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function classroomHarness() {
  const html = fs.readFileSync(path.join(__dirname, "..", "ui.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const section = (start, end) => {
    const from = script.indexOf(start);
    const to = script.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `${start} section exists`);
    return script.slice(from, to);
  };
  const source = [
    section("let boundConversationId = null;", "/** 把主进程算好的这一帧"),
    section("async function advance() {", "// ---------------------------------------------------------------- 回放"),
    "let reviewRequest = 0;",
    section("function closeReview() {", "/** 回放后主进程"),
    section("async function requestReplay(channel, payload) {", "async function clearClassroom() {"),
    section("async function clearClassroom() {", "btnPickLesson.addEventListener"),
    section('classroom.on("bind"', 'classroom.on("push"'),
    "({ advance, openReview, closeReview, requestReplay, clearClassroom, state: () => " +
      "({ boundConversationId, pushing, clearing, viewEpoch, reviewOpen, reviewQueued }) })",
  ].join("\n");

  const handlers = new Map();
  const pending = [];
  const requests = [];
  const frames = [];
  const notices = [];
  const drawer = { scrollTop: 0, scrollHeight: 0 };
  const overlay = {
    dataset: { open: "0" },
    setAttribute() {},
    querySelector: () => drawer,
  };
  const markdown = require("../vendor/markdown-it.min.js")({ html: false });
  const ui = vm.runInNewContext(source, {
    classroom: {
      on: (channel, handler) => handlers.set(channel, handler),
      invoke: (channel, args) => {
        requests.push({ channel, args });
        if (channel === "review") {
          return Promise.resolve({ ok: true, says: [`${args.conversationId} 的对白`] });
        }
        return new Promise((resolve, reject) => pending.push({ channel, args, resolve, reject }));
      },
    },
    applyFrame: (frame) => frames.push(frame.file),
    showNotice: (notice) => notices.push(notice),
    reviewOverlay: overlay,
    reviewContent: { innerHTML: "" },
    renderBoardHtml: (sourceText) => markdown.render(sourceText),
    hydrateMath: () => { drawer.scrollHeight = 200; },
    describeReplay: () => "已打开剧本",
    leaveIdle() {},
    resetBoardView() {},
    setDialog() {},
    playFigure() {},
    setHint() {},
    document: { activeElement: null },
  });
  return {
    ui, pending, requests, frames, notices, overlay,
    bind: (id) => handlers.get("bind")({ conversationId: id }),
  };
}

test("切换绑定后丢弃旧推进响应，旧 finally 不释放新推进，回看查询新会话", async () => {
  const h = classroomHarness();
  h.bind("A");
  const a = h.ui.advance();
  assert.equal(h.pending[0].args.conversationId, "A");
  await h.ui.openReview();
  assert.equal(h.ui.state().reviewQueued, true);
  h.bind("B");
  assert.equal(h.ui.state().pushing, false);
  assert.equal(h.ui.state().reviewQueued, false);
  const b = h.ui.advance();
  assert.equal(h.pending[1].args.conversationId, "B");
  h.pending[0].resolve({ ok: true, file: "A" });
  await a;
  assert.deepEqual(h.frames, []);
  assert.equal(h.ui.state().pushing, true, "A 的 finally 不能解锁 B 的在途推进");

  const version = h.ui.state().viewEpoch;
  h.bind("B");
  assert.equal(h.ui.state().viewEpoch, version, "重复绑定 B 不应撤销 B 的请求");
  h.pending[1].resolve({ ok: true, file: "B" });
  await b;
  assert.deepEqual(h.frames, ["B"]);
  assert.equal(h.ui.state().pushing, false);

  h.bind("C");
  const c = h.ui.advance();
  h.bind("D");
  const d = h.ui.advance();
  h.pending[3].resolve({ ok: true, file: "D" });
  await d;
  h.pending[2].resolve({ ok: true, file: "C" });
  await c;
  assert.deepEqual(h.frames, ["B", "D"], "晚到的 C 响应不能覆盖 D");

  await h.ui.openReview();
  assert.equal(h.requests.at(-1).channel, "review");
  assert.equal(h.requests.at(-1).args.conversationId, "D");
  assert.match(h.overlay.dataset.open, /^1$/);
  assert.deepEqual(h.notices, []);
});

test("首次绑定前发出的推进不能在绑定后覆盖新会话", async () => {
  const h = classroomHarness();
  const old = h.ui.advance();
  assert.equal(h.pending[0].args.conversationId, null);
  h.bind("A");
  h.pending[0].resolve({ ok: true, file: "旧响应" });
  await old;
  assert.deepEqual(h.frames, []);
  assert.equal(h.ui.state().pushing, false);
});

test("首次空绑定由打开剧本产生时，bind 不丢弃这次回放响应", async () => {
  const h = classroomHarness();
  const replay = h.ui.requestReplay("pick-lesson", {});
  assert.equal(h.pending[0].args.conversationId, null);
  h.bind("local");
  assert.equal(h.ui.state().viewEpoch, 0);
  h.pending[0].resolve({ ok: true, mode: "section", files: ["test.bls"], boardText: "" });
  await replay;
  assert.equal(h.ui.state().boundConversationId, "local");
  assert.deepEqual(h.notices, ["已打开剧本"]);
});

test("旧会话的回放响应在新会话绑定后不改画面", async () => {
  const h = classroomHarness();
  h.bind("A");
  const replay = h.ui.requestReplay("replay-all", {});
  h.bind("B");
  h.pending[0].resolve({ ok: true, mode: "course", files: ["A.bls"], boardText: "A 板书" });
  await replay;
  assert.equal(h.ui.state().boundConversationId, "B");
  assert.deepEqual(h.notices, []);
});

test("切换绑定后旧清空响应不重置新会话，也不解除新清空的忙碌状态", async () => {
  const h = classroomHarness();
  h.bind("A");
  const a = h.ui.clearClassroom();
  assert.equal(h.pending[0].args.conversationId, "A");
  h.bind("B");
  assert.equal(h.ui.state().clearing, false);
  const b = h.ui.clearClassroom();
  assert.equal(h.pending[1].args.conversationId, "B");
  h.pending[0].resolve({ ok: false, reason: "A 已失效" });
  await a;
  assert.equal(h.ui.state().clearing, true);
  assert.deepEqual(h.notices, []);
  h.pending[1].resolve({ ok: false, reason: "B 的错误" });
  await b;
  assert.equal(h.ui.state().clearing, false);
  assert.deepEqual(h.notices, ["B 的错误"]);
});

test("首次绑定前的清空成功响应不会清掉新会话画面", async () => {
  const h = classroomHarness();
  const old = h.ui.clearClassroom();
  h.bind("A");
  h.pending[0].resolve({ ok: true, boardText: "" });
  await old;
  assert.equal(h.ui.state().boundConversationId, "A");
  assert.equal(h.ui.state().clearing, false);
  assert.deepEqual(h.notices, []);
});
