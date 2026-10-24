const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { MAX_BYTES, readLesson, readLessonByPath } = require("../lessons.cjs");

test("工作区读取与文件选择器读取都在读盘前检查文件类型和字节数", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "better-lessons-read-test-"));
  const dir = path.join(root, "learn", "lessons");
  const valid = path.join(dir, "valid.bls");
  const oversized = path.join(dir, "oversized.bls");
  const notFile = path.join(dir, "directory.bls");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(valid, Buffer.alloc(MAX_BYTES, 0x61));
  fs.writeFileSync(oversized, Buffer.alloc(MAX_BYTES + 1, 0x61));
  fs.mkdirSync(notFile);

  const originalRead = fs.readFileSync;
  const reads = [];
  fs.readFileSync = function (filePath, ...args) {
    reads.push(filePath);
    return originalRead.call(this, filePath, ...args);
  };
  try {
    assert.throws(() => readLesson(root, "oversized.bls"), /剧本超过 65536 字节上限/);
    assert.throws(() => readLessonByPath(oversized), /剧本超过 65536 字节上限/);
    assert.throws(() => readLesson(root, "directory.bls"), /不是普通文件/);
    assert.throws(() => readLessonByPath(notFile), /不是普通文件/);
    assert.deepEqual(reads, []);

    assert.equal(readLesson(root, "valid.bls").length, MAX_BYTES);
    assert.equal(readLessonByPath(valid).length, MAX_BYTES);
    assert.deepEqual(reads, [valid, valid]);
    assert.throws(() => readLesson(root, "missing.bls"), { code: "ENOENT" });
    assert.deepEqual(reads, [valid, valid]);
  } finally {
    fs.readFileSync = originalRead;
    fs.unlinkSync(valid);
    fs.unlinkSync(oversized);
    fs.rmdirSync(notFile);
    fs.rmdirSync(dir);
    fs.rmdirSync(path.join(root, "learn"));
    fs.rmdirSync(root);
  }
});
