const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const katex = require("../vendor/katex.min.js");
const math = require("../math-renderer.js");

test("常见分式、矩阵和上下标正常渲染，外部链接不能产生锚点", () => {
  const budget = math.createBudget();
  for (const tex of ["\\frac{a}{b}+\\sqrt{x}", "\\begin{matrix}1&2\\\\3&4\\end{matrix}", "x_1^2"]) {
    const result = math.render(katex, tex, false, budget);
    assert.ok(result.html, `${tex}: ${result.reason}`);
    assert.match(result.html, /class="katex"/);
  }
  const untrusted = math.render(katex, "\\href{https://example.org/}{x}", false, budget);
  assert.doesNotMatch(untrusted.html, /<a\b|href=/i);
  const embedded = math.render(katex, "\\text{<img src=x onerror=alert(1)>}", false, budget);
  assert.ok(embedded.html);
  assert.doesNotMatch(embedded.html, /<img\b|<[^>]*\bonerror=/i);
});

test("合法 BLS 长度内的宏放大样例在调用 KaTeX 前回退为原文", () => {
  const amplified = "\\def\\a{" + "\\frac{x}{y}".repeat(20) + "}" + "\\a".repeat(400);
  assert.ok(amplified.length < math.LIMIT.formulaChars);
  const budget = math.createBudget();
  assert.equal(math.render(katex, amplified, false, budget).reason, "input-limit");
  assert.equal(budget.calls, 0);
  for (const command of ["\\gdef", "\\edef", "\\xdef", "\\let", "\\futurelet",
    "\\newcommand", "\\renewcommand", "\\providecommand"]) {
    assert.equal(math.render(katex, command + "{x}", false, budget).reason, "input-limit");
  }
  assert.equal(math.render(katex, "x".repeat(2049), false, budget).reason, "input-limit");
});

test("正向巨大尺寸受 KaTeX 限制，负向位移和抬升在插 DOM 前回退", () => {
  const positive = math.render(katex, "\\rule{1000000em}{1000000em}", true, math.createBudget());
  assert.ok(positive.html);
  assert.doesNotMatch(positive.html, /1000000em/);
  for (const tex of ["\\kern-1000000em x", "\\raisebox{-1000000em}{x}"]) {
    const result = math.render(katex, tex, true, math.createBudget());
    assert.equal(result.reason, "layout-limit", tex);
  }
});

test("单条和整块输出预算限制 KaTeX 生成的 DOM 与 HTML", () => {
  const fake = { renderToString: () => "<span>x</span>".repeat(2049) };
  assert.equal(math.render(fake, "x", false, math.createBudget()).reason, "output-limit");
  const huge = { renderToString: () => "<span>" + "x".repeat(128 * 1024) + "</span>" };
  assert.equal(math.render(huge, "x", false, math.createBudget()).reason, "output-limit");

  const budget = math.createBudget();
  const small = { renderToString: () => "<span>x</span>" };
  for (let i = 0; i < 256; i += 1) assert.ok(math.render(small, "x", false, budget).html);
  assert.equal(math.render(small, "x", false, budget).reason, "batch-limit");

  const inputBudget = math.createBudget();
  for (let i = 0; i < 8; i += 1) {
    assert.ok(math.render(small, "x".padEnd(2048), false, inputBudget).html);
  }
  assert.equal(math.render(small, "x", false, inputBudget).reason, "batch-limit");
});

test("黑板、对白和回看共用回退逻辑，保留分隔符与完整公式原文", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "ui.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const start = script.indexOf("function hydrateMath(root) {");
  const end = script.indexOf("\n    function renderInline(source)", start);
  assert.ok(start >= 0 && end > start);
  const hydrateMath = vm.runInNewContext(script.slice(start, end) + "\nhydrateMath", {
    window: { katex, LessonMath: math },
  });
  for (const display of ["blackboard", "dialog", "review"]) {
    const tex = "\\kern-1000000em x";
    const element = {
      textContent: tex,
      dataset: {},
      classList: { add(name) { element.className = name; } },
      getAttribute: () => display === "dialog" ? "0" : "1",
      removeAttribute() {},
    };
    hydrateMath({ querySelectorAll: () => [element] });
    const delim = display === "dialog" ? "$" : "$$";
    assert.equal(element.textContent, delim + tex + delim);
    assert.equal(element.className, "bl-math-fallback");
    assert.equal(element.dataset.mathFallback, "layout-limit");
    assert.equal(element.innerHTML, undefined);
  }
  assert.match(script, /hydrateMath\(boardInner\)/);
  assert.match(script, /hydrateMath\(dialogText\)/);
  assert.match(script, /hydrateMath\(reviewContent\)/);
});
