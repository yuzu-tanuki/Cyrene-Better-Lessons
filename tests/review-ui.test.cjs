const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("回看抽屉显示当前对白，收起这次操作不推进，下一次才推进", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "ui.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const advanceStart = script.indexOf("async function advance() {");
  const advanceEnd = script.indexOf("// ---------------------------------------------------------------- 回放", advanceStart);
  const reviewStart = script.indexOf("function closeReview() {");
  const reviewEnd = script.indexOf("/** 回放后主进程", reviewStart);
  assert.ok(advanceStart >= 0 && advanceEnd > advanceStart);
  assert.ok(reviewStart >= 0 && reviewEnd > reviewStart);

  const markdown = require("../vendor/markdown-it.min.js")({ html: false });
  const drawer = { scrollTop: 0, scrollHeight: 0 };
  const overlay = {
    dataset: { open: "0" },
    setAttribute(name, value) { this[name] = value; },
    querySelector: () => drawer,
  };
  let dismiss;
  let advances = 0;
  const context = vm.createContext({
    pushing: false,
    clearing: false,
    reviewOpen: false,
    reviewQueued: false,
    reviewRequest: 0,
    viewEpoch: 0,
    boundConversationId: "room",
    reviewOverlay: overlay,
    reviewContent: { innerHTML: "" },
    reviewDismiss: { addEventListener: (_name, callback) => { dismiss = callback; } },
    document: { activeElement: null },
    renderBoardHtml: (text) => markdown.render(text),
    hydrateMath() { drawer.scrollHeight = 480; },
    showNotice() {},
    applyFrame() {},
    classroom: {
      async invoke(name) {
        if (name === "review") return { ok: true, says: ["第一句", "第二句"] };
        if (name === "advance") { advances += 1; return { ok: true }; }
        throw new Error(name);
      },
    },
  });
  const ui = vm.runInContext(
    script.slice(advanceStart, advanceEnd) + script.slice(reviewStart, reviewEnd) +
      '\nreviewDismiss.addEventListener("click", closeReview); ({ advance, openReview, closeReview });',
    context,
  );

  await ui.openReview();
  assert.equal(overlay.dataset.open, "1");
  assert.match(context.reviewContent.innerHTML, /<strong>昔涟：<\/strong> 第一句/);
  assert.match(context.reviewContent.innerHTML, /<hr>/);
  assert.match(context.reviewContent.innerHTML, /<strong>昔涟：<\/strong> 第二句/);
  assert.equal(drawer.scrollTop, 480);
  await ui.advance();
  assert.equal(advances, 0);

  dismiss();
  assert.equal(overlay.dataset.open, "0");
  assert.equal(advances, 0);
  await ui.advance();
  assert.equal(advances, 1);
  drawer.scrollTop = 10;
  await ui.openReview();
  assert.equal(drawer.scrollTop, 480);
  dismiss();

  let finishAdvance;
  context.classroom.invoke = (name) => {
    if (name === "review") return Promise.resolve({ ok: true, says: ["稍后显示"] });
    if (name === "advance") return new Promise((resolve) => {
      advances += 1;
      finishAdvance = resolve;
    });
    throw new Error(name);
  };
  const pending = ui.advance();
  await ui.openReview();
  assert.equal(overlay.dataset.open, "0");
  assert.equal(context.reviewQueued, true);
  finishAdvance({ ok: true });
  await pending;
  assert.equal(overlay.dataset.open, "1");
  assert.equal(advances, 2);
});
