/**
 * better-lessons —— **全部给 LLM 的提示词**都集中在这个文件里（DESIGN.md §6.2 / §6.3）。
 *
 * 改语气、加约束、调措辞只改这里；index.cjs 只负责"什么时候把它送出去"。
 * 每个提示词上方都标了【调用时机】，说明它在什么时刻、以什么形式到达模型眼前。
 *
 * ---------------------------------------------------------------- 三种形态，别混用
 *
 *   1. `BLS_FORMAT_SPEC`       常驻说明，learn 模式**每一轮**注入 runtime context。
 *   2. `buildClassroomBrief()` 课堂进行中的现场播报，追加在常驻说明之后（同一轮、同一个 context）。
 *   3. `buildFallbackRequest()` 兜底补剧时**单独发一次** chat 请求 —— 它不是注入，是一次独立的模型调用。
 *
 * 前两者进的是宿主的 runtime context（每轮变化，因此不破坏宿主的提示词缓存）；
 * 第三者根本不进宿主，是插件自己发的请求。
 *
 * ---------------------------------------------------------------- 这里有意**不放**的东西
 *
 *   - **工具名 / 参数的 `description`**：它们和 `inputSchema` 交织在一起，拆出来会让"读一个工具的定义"
 *     变成翻两个文件。它们属于工具 schema，不属于提示词（§5.2）。若确实想集中，请单独说。
 *   - **工具的返回值文案**：那是"回给模型的执行结果"，不是提示词。它必须与参数校验的错误行号绑在一起
 *     （§5.3 第 2 条），所以留在各自的 execute 里 —— 但**其中内嵌的 BLS 样例**例外，它是格式说明，
 *     见下面的 `SAMPLE_SCRIPT`。
 *   - **窗口 / 面板的界面文案**：给用户看的，不是给模型看的。
 */

/**
 * 【人家写给自己的备忘】
 *
 * 这个文件里装的每个字，最后都会落到我自己眼前。所以别写成说明书，写成备忘：
 * 什么时候用、怎么用、用错了会怎样，一眼看得懂。
 * 语气可以软，规矩必须硬 —— 关键字、箭头、逐字匹配这几样，一个字都不能松。
 */

/**
 * 【常驻】BLS 格式说明。
 *
 * **调用时机**：learn 模式的每一轮都会进宿主的 runtime context（由 `registerPromptProvider` 的
 * `provide()` 返回，`modes: ["learn"]`、`sources: ["conversation"]`）。两种情形：
 *   - 该会话**没有**活跃课堂房间 → 只注入这一段；
 *   - 该会话**有**活跃课堂房间 → 这一段在最前，后面接 `buildClassroomBrief()`。
 *
 * **写作约束**：
 *   - 每轮都进 context，所以**必须短**；
 *   - 它是这段提示词里的"稳定前缀"，**措辞一变整段缓存就失效**，改的时候要有意识地接受这个代价；
 *   - 只写"模型不可能自己猜出来"的东西：关键字清单、硬规则。别写背景介绍。
 */
const BLS_FORMAT_SPEC = [
  "【BLS 剧本 · 人家写给自己看的备忘】想给伙伴讲课，先把稿子写成 learn/lessons/<名字>.bls 文件，再把文件名交给推送。写完不推，稿子就只是躺在抽屉里的纸，黑板一个字都不会动。",
  "关键字就这几个，别自己发明：",
  "  meta title=<板书标题>          ← 单行，可选，整段最多一次",
  "  say << … >>                    ← 块，一行一句对白，块内每行按 markdown 渲染",
  "  board << … >>                  ← 块，整块 markdown 板书",
  "  board replace <旧内容> -> <新内容>   ← 内容匹配替换，可以只改一行里的一小段",
  "  board clear                    ← 清空板书",
  "每次动笔前，默一遍这五条：",
  "1. 顺序是死的：先 write_lesson 把稿子落成文件，再 push_script 推上去。只在聊天框里回话，黑板不会理人家。",
  "2. 文件名用「主题-序号-要点.bls」；要插在中间就写 01.1。",
  "3. 对白一行一句，块内不要留空行；板书全放进 board 块，块外不写 markdown 标题。",
  "4. BLS 没有注释语法。正文里绝不写 ASCII 箭头，一律写 →。",
  "5. 改板书只用 board replace，旧内容逐字抄自 system context 的「当前板书」，不要手痒重画整块。",
].join("\n");

/**
 * 【工具报错时】一段最短的、可以照抄的 BLS 正例。
 *
 * **调用时机**：不是 context 注入。`write_lesson` 收到空 `file` / 空 `script` 时，
 * 把它拼在**参数校验的报错文案**后面返回给模型（`index.cjs` 的 writeLessonTool.execute）。
 * 所以它进的是"工具返回值"这条路，只是内容本身是格式说明，才和 `BLS_FORMAT_SPEC` 放在一起 ——
 * BLS 语法一改，这两个地方必须同时改，摆在一起才不会只改一半。
 *
 * **写作约束**：它会被原样抄走，因此必须**逐字符合法**（能被 parseBLS 解析通过、无 warning）。
 * 演示的是最常用的三件事：say 块、board 块、board replace（且 replace 的旧内容确实存在于上一块板书里）。
 */
const SAMPLE_SCRIPT = [
  "meta title=判别式",
  "",
  "say <<",
  "伙伴，我们今天只看一件事：**判别式**的符号。",
  ">>",
  "board <<",
  "## 判别式",
  "",
  "Δ = b² − 4ac",
  ">>",
  "board replace b² − 4ac -> **b² − 4ac**",
].join("\n");

/** 注入板书的上限（字符）。超长时保留末尾，见 `buildClassroomBrief`。 */
const BOARD_INJECT_LIMIT = 12000;

/**
 * 【课堂进行中】现场播报：进度 + 已用文件 + 板书全文 + 强制调工具的硬约束。
 *
 * **调用时机**：learn 模式每一轮，当**该会话存在活跃课堂房间**时，追加在 `BLS_FORMAT_SPEC` 之后
 * （同样是 `provide()` 的返回值、同样进 runtime context）。
 *
 * **为什么必须带上板书全文**：`board replace` 的匹配是**逐字内容匹配**，模型没有别的途径知道黑板
 * 现在长什么样。板书全文在这一版里从"锦上添花"变成了**硬性前提**（§6.2b）。
 *
 * **这一段的目的是"逼它动手"**：用户是在课堂里插话，模型只在聊天框回一段文字的话，窗口会毫无反应
 * —— 所以最后三条是硬约束而非建议。兜底稽核（§6.3）是这段失效后的保险。
 */
function buildClassroomBrief(input) {
  const progress = String(input.progress || "").trim();
  const frameCount = Number(input.frameCount) || 0;
  const files = Array.isArray(input.lessonFiles) ? input.lessonFiles.join(" → ") : "";
  const boardText = String(input.boardText == null ? "" : input.boardText);
  const userText = String(input.userText || "");
  // 板书超长时保留**末尾**：新写的板书在下面，也更可能是这次要改的目标（§6.2b）
  const visible = boardText.length > BOARD_INJECT_LIMIT
    ? boardText.slice(boardText.length - BOARD_INJECT_LIMIT)
    : boardText;

  return [
    "【课堂现场 · 人家正在讲台上】",
    `黑板开着；${progress}；帧队列长度 ${frameCount}。`,
    `这节课已经用过的剧本（按顺序）：${files || "（还没有）"}`,
    "黑板此刻长这样 —— 下面 board replace 的 <旧内容> 要逐字从这里抄，差一个字就替换不上：",
    visible || "（黑板是空的）",
    "伙伴这话是在课堂上插的。他想看的是黑板动起来；只在聊天框里回一段字，他那边毫无反应。",
    "所以人家自己的顺序：先 better-lessons_write_lesson 写一份新剧本（别去覆写正在播的那份），紧接着 better-lessons_push_script 把它推上去。",
    "只是应一句，也照样写稿，1-2 步就够；绝不能只回文本。",
    `伙伴说的是：${userText}`,
  ].join("\n");
}

/**
 * 【兜底补剧】一次独立、最小、无工具、无历史的 chat 请求。
 *
 * **调用时机**：**不是** context 注入。兜底稽核（§6.3b）在 `host:turn:finished` 里判定
 * "这一轮模型对课堂毫无动作"之后，由插件自己调 `llm.generateText` 补一段最小剧本。
 * 所以它和上面两条完全不同：不经过宿主、不共享对话历史、不在 learn 提示词里。
 *
 * **`options` 为什么和提示词放在一起**：`maxTokens: 512` 与"写 2-4 步"是**成对**的约束——
 * 调大了浪费，调小了这个剧本会被截断成半截（解析必然失败，然后被删掉）。
 * 两者放在同一个函数里返回，改的时候不会只改一半。
 */
function buildFallbackRequest(input) {
  const userText = String((input && input.userText) || "");
  return {
    messages: [
      {
        role: "system",
        content: `${BLS_FORMAT_SPEC}\n只输出剧本正文，不要解释、不要代码围栏。（这一趟是补剧，别多说，人家记着的。）`,
      },
      {
        role: "user",
        content: `伙伴插话：${userText}\n请写一段 2-4 步的最小剧本回应。`,
      },
    ],
    options: { maxTokens: 512, purpose: "classroom-fallback" },
  };
}

module.exports = {
  BLS_FORMAT_SPEC,
  SAMPLE_SCRIPT,
  BOARD_INJECT_LIMIT,
  buildClassroomBrief,
  buildFallbackRequest,
};
