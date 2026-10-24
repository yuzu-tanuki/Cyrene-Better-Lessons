const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const plugin = require("../index.cjs");

test("主进程在异步回放期间切到新会话后取消旧回放，不重新绑定旧会话", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "better-lessons-bind-race-"));
  const lessonDir = path.join(root, "learn", "lessons");
  const handlers = new Map();
  const tools = new Map();
  let finishOldBinding;
  const oldBinding = new Promise((resolve) => { finishOldBinding = resolve; });
  fs.mkdirSync(lessonDir, { recursive: true });
  for (const file of ["A.bls", "B.bls"]) {
    fs.writeFileSync(path.join(lessonDir, file), `say <<\n${file}\n>>\n`, "utf8");
  }

  try {
    await plugin.register({
      registerTool: (tool) => tools.set(tool.id, tool),
      registerPromptProvider() {},
      registerIpc: (name, handler) => handlers.set(name, handler),
      events: { on() {} },
      onDispose() {},
      log() {},
      storage: {
        get: (key) => key === "prefs" ? { autoOpen: false } : null,
        set() {},
      },
      deps: {
        workspace: {
          getBinding: (conversationId) => conversationId === "A" ? oldBinding : { root },
        },
      },
    });
    const push = tools.get("better-lessons_push_script").execute;
    assert.match(await push({ file: "A.bls" }, {
      conversationId: "A", resolvedWorkspaceRoot: root,
    }), /已推送/);
    assert.equal(handlers.get("state")().boundConversationId, "A");

    const oldReplay = handlers.get("replay-all")({ conversationId: "A" });
    assert.match(await push({ file: "B.bls" }, {
      conversationId: "B", resolvedWorkspaceRoot: root,
    }), /已推送/);
    assert.equal(handlers.get("state")().boundConversationId, "B");

    finishOldBinding({ root });
    assert.deepEqual(await oldReplay, { ok: false, canceled: true });
    assert.equal(handlers.get("state")().boundConversationId, "B");
  } finally {
    finishOldBinding({ root });
    plugin.unregister();
    for (const file of ["A.bls", "B.bls"]) fs.unlinkSync(path.join(lessonDir, file));
    fs.rmdirSync(lessonDir);
    fs.rmdirSync(path.join(root, "learn"));
    fs.rmdirSync(root);
  }
});
