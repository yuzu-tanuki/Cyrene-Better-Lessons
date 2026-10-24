const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("空格和回车各推进一步，按键重复及控件焦点不推进", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "ui.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const start = script.indexOf('window.addEventListener("keydown"');
  const end = script.indexOf("// ---------------------------------------------------------------- 主进程 → 窗口", start);
  assert.ok(start >= 0 && end > start);

  let listener;
  let advances = 0;
  let selected = false;
  vm.runInNewContext(script.slice(start, end), {
    window: {
      addEventListener: (_name, callback) => { listener = callback; },
      getSelection: () => ({ isCollapsed: !selected }),
    },
    advance: () => { advances += 1; },
  });

  const press = (key, changes = {}) => {
    const event = {
      key,
      target: { closest: () => null },
      preventDefault() { this.prevented = true; },
      ...changes,
    };
    listener(event);
    return event;
  };

  assert.equal(press(" ").prevented, true);
  assert.equal(press("Enter").prevented, true);
  assert.equal(advances, 2);

  for (const event of [
    press("a"),
    press(" ", { repeat: true }),
    press("Enter", { isComposing: true }),
    press(" ", { ctrlKey: true }),
    press("Enter", { target: { closest: () => ({ tagName: "BUTTON" }) } }),
  ]) assert.equal(event.prevented, undefined);
  selected = true;
  assert.equal(press(" ").prevented, undefined);
  assert.equal(advances, 2);
});
