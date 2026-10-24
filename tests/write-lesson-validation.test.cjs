const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const plugin = require("../index.cjs");
const { LIMITS } = require("../bls.cjs");

test("write_lesson 在 BLS 校验失败时保留已有剧本，也不创建无效的新文件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "better-lessons-write-test-"));
  const lessonDir = path.join(root, "learn", "lessons");
  const file = "existing.bls";
  const target = path.join(lessonDir, file);
  const original = "meta title=用户修改过的剧本\nsay <<\n原来的内容\n>>\n";
  const tools = new Map();
  fs.mkdirSync(lessonDir, { recursive: true });
  fs.writeFileSync(target, original, "utf8");

  try {
    await plugin.register({
      registerTool: (tool) => tools.set(tool.id, tool),
      registerPromptProvider() {},
      registerIpc() {},
      events: { on() {} },
      onDispose() {},
      log() {},
    });
    const write = tools.get("better-lessons_write_lesson").execute;
    const context = { resolvedWorkspaceRoot: root, conversationId: "test" };
    const invalidScripts = [
      "meta title=没有有效步骤\nboard replace 缺少箭头",
      "x".repeat(LIMITS.scriptChars + 1),
      `say <<\n${Array(LIMITS.stepsPerLayer + 1).fill("一句对白").join("\n")}\n>>`,
    ];

    for (const script of invalidScripts) {
      const response = await write({ file, script }, context);
      assert.match(response, /校验不通过，未写入/);
      assert.equal(fs.readFileSync(target, "utf8"), original);
    }

    const response = await write({ file: "new.bls", script: invalidScripts[0] }, context);
    assert.match(response, /校验不通过，未写入/);
    assert.equal(fs.existsSync(path.join(lessonDir, "new.bls")), false);

    const updated = "say <<\n更新后的内容\n>>";
    const success = await write({ file, script: updated }, context);
    assert.match(success, /已覆盖/);
    assert.equal(fs.readFileSync(target, "utf8"), updated);
  } finally {
    plugin.unregister();
    fs.unlinkSync(target);
    fs.rmdirSync(lessonDir);
    fs.rmdirSync(path.join(root, "learn"));
    fs.rmdirSync(root);
  }
});
