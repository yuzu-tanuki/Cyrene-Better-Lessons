const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const lessons = require("../lessons.cjs");

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "better-lessons-path-test-"));
  const root = path.join(base, "workspace");
  const dir = path.join(root, "learn", "lessons");
  const outside = path.join(base, "outside.bls");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outside, "outside secret", "utf8");
  return { base, root, dir, outside, clean: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function withMockedLink(link, action) {
  const original = fs.lstatSync;
  fs.lstatSync = function (target, ...args) {
    const stat = original.call(this, target, ...args);
    if (path.resolve(target) !== link) return stat;
    return { ...stat, isSymbolicLink: () => true };
  };
  try {
    action();
  } finally {
    fs.lstatSync = original;
  }
}

test("工作区剧本文件为符号链接时拒绝读写，不修改外部文件", (t) => {
  const { root, dir, outside, clean } = fixture();
  const link = path.join(dir, "linked.bls");
  let realLink = false;
  try {
    try {
      fs.symlinkSync(outside, link, "file");
      realLink = true;
    } catch (err) {
      if (!err || err.code !== "EPERM") throw err;
      fs.writeFileSync(link, "placeholder", "utf8");
      t.diagnostic("当前环境禁止创建符号链接；使用 lstat 模拟链接类型");
    }
    const check = () => {
      assert.throws(() => lessons.readLesson(root, "linked.bls"), /符号链接/);
      assert.throws(() => lessons.writeLesson(root, "linked.bls", "replacement"), /符号链接/);
    };
    if (realLink) check();
    else withMockedLink(link, check);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside secret");
  } finally {
    clean();
  }
});

test("learn/lessons 目录链接不能成为模型读写入口", (t) => {
  const { root, outside, clean } = fixture();
  const learn = path.join(root, "learn");
  try {
    const check = () => {
      assert.throws(() => lessons.readLesson(root, "outside.bls"), /符号链接/);
      assert.throws(() => lessons.writeLesson(root, "outside.bls", "replacement"), /符号链接/);
    };
    t.diagnostic("通过 lstat 模拟目录链接，避免依赖系统的链接创建权限");
    withMockedLink(learn, check);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside secret");
  } finally {
    clean();
  }
});

test("检查后打开了不同文件句柄时拒绝读写，不截断该文件", () => {
  const { root, dir, outside, clean } = fixture();
  const target = path.join(dir, "lesson.bls");
  fs.writeFileSync(target, "inside lesson", "utf8");
  const originalOpen = fs.openSync;
  try {
    fs.openSync = function (file, flags, ...args) {
      return originalOpen.call(this, file === target ? outside : file, flags, ...args);
    };
    assert.throws(() => lessons.readLesson(root, "lesson.bls"), /发生变化/);
    assert.throws(() => lessons.writeLesson(root, "lesson.bls", "replacement"), /发生变化/);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside secret");
    assert.equal(fs.readFileSync(target, "utf8"), "inside lesson");
  } finally {
    fs.openSync = originalOpen;
    clean();
  }
});

test("已有剧本与外部文件共享硬链接时拒绝覆盖", () => {
  const { root, dir, outside, clean } = fixture();
  const target = path.join(dir, "linked.bls");
  const originalFstat = fs.fstatSync;
  try {
    fs.writeFileSync(target, "inside lesson", "utf8");
    fs.fstatSync = function (fd, ...args) {
      const stat = originalFstat.call(this, fd, ...args);
      const mocked = Object.create(stat);
      Object.defineProperty(mocked, "nlink", { value: 2 });
      return mocked;
    };
    assert.throws(() => lessons.writeLesson(root, "linked.bls", "replacement"), /硬链接/);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside secret");
    assert.equal(fs.readFileSync(target, "utf8"), "inside lesson");
  } finally {
    fs.fstatSync = originalFstat;
    clean();
  }
});
