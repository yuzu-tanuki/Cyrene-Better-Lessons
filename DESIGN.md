# better-lessons 架构设计

> 插件 id：`better-lessons`　|　目标插件版本：0.1.0　|　Plugin API：v1
>
> 一句话：把 learn 模式的对话式讲解，变成一间可以"演"出来的教室。
## 项目记忆：examples\better-lessons\memory.md
## 1. 目标与非目标

### 1.1 目标

1. 约定一种文本格式 **BLS（Better Lesson Script）**，用于描述一堂课的演出顺序：对白、板书、板书内容替换（含擦除与强调）、清板。
2. 把 BLS 正文**落盘到工作区的 `learn/lessons/` 目录**，并暴露一对工具接口：`better-lessons_write_lesson`（写入剧本文件）与 `better-lessons_push_script`（按文件名推送进课堂窗口）。大模型在 learn 模式下**可选地**把要说的话写成剧本并演出。
3. 打开一个独立窗口（galgame 形态）：教室背景 + 黑板 + 人物立绘 + 底部对话框。**全部美术素材由插件自带，不依赖宿主仓库**；窗口默认占半屏，另一半留给用户自己安排（例如打开宿主 learn 模式写在 `notes/` 里的笔记）。
4. 由**用户鼠标点击**驱动播放：一次点击推进一个 step。
5. 支持**课堂插话**：用户在宿主对话框发消息 → 模型产出新剧本 → 窗口打断当前播放、优先演完新剧本、插入过渡帧、然后回到被打断的那一层继续演。
6. 支持**课堂回放**：剧本以文件形式留在工作区里，按文件名即可重新演出；用户也可以直接编辑那些文件。

### 1.2 非目标

- 不做语音合成与口型同步（未来可选扩展，不进入 v1 契约）。
- 不做课件文件导入（PDF/PPT 转剧本）。
- 不改动宿主任何代码，**也不读取宿主仓库里的任何美术素材**。全部能力只依赖 Plugin API v1 的公开契约，全部素材只依赖插件自己的 `assets/`。
- **既不渲染笔记、也不生产笔记**。笔记是宿主 learn 模式自己的事（写在 `notes/`），插件不读、不写、不碰任何笔记文件（见第 10 节）。
- 不做多人/联机课堂。

## 2. 术语

| 术语 | 含义 |
|---|---|
| **BLS** | 剧本文本格式，见第 4 节 |
| **LessonFile** | `learn/lessons/` 下的一个 `.bls` 文件，承载**一层**的剧本正文；剧本的唯一真相源，也是回放的最小单位 |
| **Layer（层）** | 一次工具推送产生的一整段剧本，与一个 LessonFile 一一对应，是打断/恢复的最小单位 |
| **Step（步）** | 层内的一个演出动作，一次鼠标点击推进一个 step |
| **Frame（帧）** | 窗口播放队列里的元素，可以是 layer 也可以是本地合成的 transition |
| **Room（房间）** | 一个会话对应的课堂实例，key 为 `conversationId` |
| **Board（黑板）** | 一篇 markdown 文档，见第 8 节 |
| **BoardOp** | 黑板增量操作（追加块 / 内容替换 / 清空），用于断点重绘 |

## 3. 总体架构

### 3.1 三层职责

```
┌─────────────────────────────────────────────────────────────┐
│ 宿主（Cyrene 主进程 + 聊天渲染端）                             │
│  · 提供 learn 模式与聊天输入框 —— 课堂插话的唯一入口            │
│  · 调度 LLM，把工具调用派发给插件                              │
│  · 发布 host:turn:started / host:tool:finished / host:turn:finished │
└───────────────┬─────────────────────────────────────────────┘
                │ Plugin API v1（registerTool / registerPromptProvider /
                │ events.on / deps.llm），宿主对插件窗口不感知
┌───────────────▼─────────────────────────────────────────────┐
│ 插件主进程（examples/better-lessons/index.cjs）               │
│  · 读写 <workspace>/learn/lessons/*.bls（剧本的唯一真相源）      │
│  · BLS 解析与校验 → 内部 IR（JSON AST）                        │
│  · Room 注册表：conversationId → { win, frames, board, lastUserText } │
│  · 把新层 webContents.send 给窗口（execute 内首行同步发送）      │
│  · Provider：向每轮请求注入课堂状态 + 强制调用工具的硬约束       │
│  · 兜底：轮次稽核 → 模型漏调工具时自行补一段最小剧本            │
└───────────────┬─────────────────────────────────────────────┘
                │ webContents.send（主进程 → 窗口）
                │ ipcRenderer.invoke("plugin:better-lessons:*")（窗口 → 主进程）
┌───────────────▼─────────────────────────────────────────────┐
│ 插件窗口（examples/better-lessons/ui.html + 内联脚本）        │
│  · 帧队列与播放状态机（第 7 节）                               │
│  · markdown 黑板渲染 + 断点重绘（第 8 节）                     │
│  · 立绘走去停回三拍演出（第 9 节）                             │
│  · 素材全部来自插件自带 assets/，不读宿主仓库（第 9 节）        │
└─────────────────────────────────────────────────────────────┘
```

**关键架构判断：播放状态机放在窗口里，不放在插件主进程。**
理由是宿主不提供工具执行期的增量流式输出（`PluginToolContext` 无 emit/progress，`HarnessEvent` 只有 `tool_start` / `tool_end`），工具执行是原子的。所以工具只负责"把整层剧本递过去"，节奏完全由窗口的点击事件驱动。

### 3.2 一次课堂的完整时序

```
① 用户在 learn 会话说「给我讲讲判别式」
② 宿主 LLM 调用 better-lessons_write_lesson(file=判别式-01-引入.bls, script=BLS 文本)
③ 插件主进程：写入 <workspace>/learn/lessons/判别式-01-引入.bls，返回路径与步数摘要
④ 模型接着调用 better-lessons_push_script(file=判别式-01-引入.bls)
⑤ 插件主进程：读盘 → 解析 → 校验 → 建 Layer → webContents.send("plugin:better-lessons:push")
   若窗口不存在则先 open() 再发送
⑥ 工具返回短字符串「已推送第 1 层，共 9 步」→ 模型据此收尾
⑦ 窗口播放第 1 层，用户逐帧点击推进
⑧ 用户在看第 1 层第 5 步时，在宿主对话框输入「等等，Δ<0 是什么情况？」
⑨ 宿主开启新一轮 run，Provider 注入「课堂进行中，当前第 5/9 步，当前板书全文如下，必须写一个新剧本并推送」
⑩ 模型写第 2 个剧本文件（判别式-01.1-补充.bls）并推送 → 同样走 ②~⑥
⑪ 窗口：冻结第 1 层 cursor=5 → 插入 transition(in)（清板 + 过渡文案）
   → 播放第 2 层
⑫ 第 2 层播完 → 插入 transition(out) → 清板重绘第 1 层的 0..4 步（瞬时、无动画）
   → 从第 5 步继续播放
```

### 3.3 呈现层技术选型：哪些自己写，哪些引第三方

插件窗口是 `loadFile(ui.html)` + `nodeIntegration: true` 的**无打包器环境**：没有 bundler、没有 npm 安装步骤、也没有远程 CDN 可用（离线应用）。所以"能不能用第三方库"的真实约束是——**必须能以单文件 UMD/IIFE 形式 vendored 进插件目录，用 `<script src="vendor/…">` 直接加载**。不能 `npm install` 进插件目录：`node_modules` 的条目数会直接顶爆 ZIP 导入的 2000 条目上限。

| 层 | 决策 | 理由 |
|---|---|---|
| **galgame 呈现层** | **自研**（DOM + CSS transition，几百行） | 需求就是"教室背景 / 黑板 / 两个立绘槽 / 对话框"四层绝对定位 + 交叉淡入淡出 + 200ms 过渡。引 Phaser / PixiJS 这类渲染引擎，等于为静态图和淡入淡出背上几百 KB 运行时和一套渲染循环；引 Monogatari 这类网页 galgame 引擎，则要再学它自己的剧本 DSL——而 **BLS 已经是剧本 DSL**，两套 DSL 会互相打架（`ink` 同理） |
| **markdown 渲染** | **第三方**：`markdown-it`（单文件 UMD，115 KiB） | 自研 markdown 解析器是纯粹的重复劳动，坑（嵌套、转义、表格对齐、列表缩进）极多。选它还有一个具体原因：**token 流自带 `map: [startLine, endLine]`**，正好用来给块级元素打 `data-line` 标记，满足 8.2 要求的"按块级元素切出文本归属"，也就是 `boardReplace` 命中段落 → DOM 节点的映射 |
| **HTML 净化** | **必须**：`DOMPurify`（单文件，29 KiB） | 这个窗口开着 `nodeIntegration: true`，意味着**一次 XSS 就是任意代码执行**。而板书正文由模型生成，完全可能带出 `<img onerror=…>` 这类内容。这不是可选项；宿主渲染端也已经在用它做 SVG 消毒 |
| **数学公式** | `KaTeX` UMD + auto-render。**v1 不做，留作扩展** | 数学课的板书用纯文本渲染 `Δ = b² − 4ac` 勉强能看，但分数、根号、积分就不行了。代价是 KaTeX 附带一批字体文件，要算进 ZIP 条目预算 |
| **滚动与布局** | 原生 CSS | `overflow: auto` + `flex` + `clamp()` 足够；单层最多 200 步、单文件 ≤ 64 KiB，不需要虚拟滚动 |
| **Live2D** | **不引入** | 立绘是四张静态图（9.1），唯一的"动画"是两槽交叉淡入淡出、擦板两帧交替与讲述槽的跳动，全是 CSS 能做的事 |

**vendored 产物与 `assets/` 并列**：

```
vendor/
├── markdown-it.min.js
├── markdown-it.LICENSE
├── purify.min.js
├── purify.LICENSE
└── LICENSES.md        # 来源、版本、许可证标识（副本见相邻的 .LICENSE 文件）
```

全部走**标准 markdown**，不引任何语法扩展插件——强调直接用 `**加粗**`（见 8.2）。

没有打包器就没有 lockfile 可依赖，所以**每个 vendored 文件都要在 `LICENSES.md` 里记下版本号**，升级时手工替换。许可证方面 `markdown-it` / `KaTeX` 是 MIT，`DOMPurify` 是 Apache-2.0 或 MPL-2.0 双许可，都可以随插件分发（附副本即可）。

**一句话总结**：**galgame 那层自研，markdown 那层引库，净化必须引库。** 自研的部分是"怎么摆"，有明确边界、几百行能写完；引库的部分是"怎么解析"，无限长尾且已有成熟实现。

## 4. BLS：剧本文本格式 v1

### 4.1 为什么是行式 DSL 而不是嵌套 JSON

工具调用的外层参数必然是 JSON，但**剧本正文**选择行式 DSL 承载，理由：

1. 剧本由若干个**块**组成，块内每行是一条指令——这种标注格式（剧本、字幕、时间轴）模型远比深层嵌套 JSON 熟练，长剧本的出错率显著更低。
2. 宿主主聊天路径**不做参数校验**（只 `JSON.parse`，失败回落 `{}`），嵌套 JSON 写错只能靠插件自己兜；行式解析器可以精确定位到行号并反馈"第 7 行缺少 `->` 分隔符"，模型下一轮能自我修正。
3. 提示词里给一份行式样例比给一份 JSON Schema 更省 token，而且人类可读、便于事后翻看剧本文件。
4. 板书正文本身就是 markdown。用"引用一段旧文本 → 换成新文本"来表达改写，比 JSON 数组紧凑得多，也让"把这句话擦掉、把那句话圈出来"这种课堂动作有一个自然的书写方式——**而且不需要模型维护任何行号**。

内部仍解析成 JSON IR，因此未来若要增加结构化调用入口（`steps` 数组），只需加一个适配器，不用动运行时。

### 4.2 语法

```
meta title=<板书标题>

say <<
<多行 markdown 对白，每行一条>
>>

board <<
<markdown 原文，可多行，直到单独一行的 >> 为止>
>>

board replace <旧内容> -> <新内容>
board clear
```

全文只有 **4 个关键字**：`meta`、`say`、`board`、以及 `board` 的两种编辑形态（`replace` / `clear`）。`say` 与 `board` 都是块，用同一个 `>>` 收尾；`meta` 与 `board replace` / `board clear` 是单行指令。

**词法约定**

- **BLS 没有注释语法**。任何不在下面列出的行、以及块外的散行都是"无法识别的行"，跳过并告警（最常见的是模型把 markdown 标题写在了块外面）。
- `meta title=<标题>`，整段剧本最多一次，可省略。省略时窗口取本层第一块板书里的首个 markdown 标题（`#`/`##`）作为层标题，再退化为「第 N 层」。
- `say <<` / `board <<` 的起始行与收尾的 `>>` 必须各占一行；`>>` 之后不允许有其他字符。块内所有字符原样收入（仅去掉公共缩进），块内空行保留，markdown 需要它分段。
- **`say` 块由解析器按行拆成 step**：每条非空行 → 一个 `say` step，行首尾空白裁掉。想让一句话分两次点击显示，就写成两行。对白一次只显示一行，因此块内不解析跨行结构。
- **`board` 块整体算一个 step**（不按行拆）：黑板要按整篇 markdown 渲染，拆开会让列表、表格、引用断掉。
- `say` 块内每行、`board` 块内每行都按 markdown 渲染：`say` 是单行行内 markdown，`board` 是整篇块级 markdown。
- `board replace <旧内容> -> <新内容>`：在黑板当前文本里**自动查找** `旧内容`，替换成 `新内容`。两侧都是单行内容，替换可以只命中一行里的**一部分**；`新内容` 允许为空（等于擦掉这一段）。
- **`->` 是 BLS 正文里唯一的分隔符，正文中禁止出现 ASCII 箭头 `->`**；要表达箭头请写 `→`（U+2192）。这一条同时适用于对白、板书块与 replace 的两侧，是 BLS 里唯一需要明确禁止的写法。
- 单行（含块内每行）最多 2000 字符；单层最多 200 步（`say` 块的每一行都计一步）；整段剧本最多 48000 字符。

### 4.3 示例

```
meta title=判别式

say <<
伙伴，我们今天只看一件事：**判别式**的符号。
>>
board <<
## 判别式

Δ = b² − 4ac
>>

say <<
它就是这条式子里的 Δ。
它的符号，直接决定抛物线与 x 轴交点的个数。
>>
board <<
> Δ > 0 → 两个交点
> Δ = 0 → 一个交点
> Δ < 0 → 没有交点
>>

board replace Δ < 0 → 没有交点 -> **Δ < 0 → 没有交点**
say <<
那 Δ < 0 的情况，图像长什么样？
>>
board clear
say <<
我们把这条留到最后再展开。
>>
```

这段剧本解析出来是 9 个 step：4 个 `say` 块贡献了 5 步（第二个块有两行，拆成两步），2 个 `board` 块各贡献 1 步，加上 1 步 `board replace` 与 1 步 `board clear`。

最后那条 `board replace` 只改掉了 `> Δ < 0 → 没有交点` 这一行里的**一部分**（`Δ < 0 → 没有交点`），把它换成了 `**加粗**` 的写法——`board replace` 负责擦除、改写、强调三种动作，区别只在替换成什么 markdown。全程没有任何行号需要模型去数。

### 4.4 Step 的 IR 形态

```ts
type Step =
  | { kind: "say";          text: string }                  // 单行 markdown，来自 say 块按行拆分
  | { kind: "boardBlock";   lines: string[] }               // 追加一整块 markdown
  | { kind: "boardReplace"; from: string; to: string }      // 内容匹配替换，两侧均为单行
  | { kind: "boardClear" };

type BoardOp = Step & { stepIndex: number };   // 黑板类 step 的投影，带来源步号

type Layer = {
  id: string;              // lay_<conversationHash>_<seq>
  runId: string;           // 来自 PluginToolContext.runId
  conversationId: string;
  index: number;           // 该会话内第几层，从 0 起
  file: string;            // learn/lessons/ 下的文件名 —— 层的身份，也是回放句柄
  title?: string;          // 来自 meta title；省略时窗口按 4.2 的规则推导
  steps: Step[];           // 由文件内容解析而来，不随持久化保存
  cursor: number;          // 断点：下一步待播放的索引
  boardOps: BoardOp[];     // 本层产生的黑板增量，由 steps 投影而来
  transitionHint?: string; // 模型给的"我们回到刚才那道题"
  fallback?: boolean;      // 由插件兜底补剧生成，窗口角落显示轻标记
};
```

`boardOps` 是 `steps` 中所有黑板类 step 的**投影**。它单独存一份的原因见第 8 节：断点恢复时需要"瞬时重放"到 cursor，而不是带动画重演一遍。

### 4.5 校验规则

解析失败的七种结局：

| 情况 | 处理 |
|---|---|
| 无法识别的行 | **跳过该行**，累积 warning，继续解析 |
| `say <<` 或 `board <<` 没有配对的 `>>` | 从该块起始行起到剧本末尾**全部丢弃**，累积 warning |
| `say` 块内有效行数为 0（整块空行） | 该块不产生任何 step，告警 |
| `board replace` 缺 `->`、或 `旧内容` 为空 | **跳过该行**，累积 warning（`新内容` 为空是合法的） |
| `board replace` 的 `旧内容` 在黑板里找不到 | **忽略该步**并告警 |
| `board replace` 的 `旧内容` 命中多处 | 替换**第一处**并告警（提示模型引用更长的上下文以唯一定位） |
| 解析后 0 个有效 step | 工具返回错误说明（含前 3 条 warning + 行号），**不推送**，让模型重写 |

宁可少演一帧，也不要让窗口抛异常卡死——窗口是长时间驻留的，任何未捕获异常都会让用户面对一块死掉的黑板。

**"命中多处"选择宽容而非拒绝**：拒绝会让黑板状态与模型的预期逐渐错位，后续 replace 引用的旧内容会连锁失配，一步错、步步错；替换第一处至少让黑板保持在模型可预测的演化路径上，告警则提示它下一轮把上下文写长一点。

**校验必须按重放顺序做**：某条 `board replace` 能否命中，取决于它之前的所有 step 已经把什么写进了黑板。因此校验器、播放器、断点重绘器共用同一个 `apply(op, board)` 纯函数（8.1），避免三处实现漂移。

**层与层之间不共享黑板**：换层时过渡帧会清板（7.4），所以**每一层都从一块空黑板开始演**。这条不变式有两个直接后果：

- `parseBLS` 只需要在本层内部累积的草稿板上做校验，不需要外部黑板入参，因此它是纯函数；
- 跨层引用（B 层去改 A 层写的板书）**一律 miss** 并告警。这是有意的：模型要改的应该是自己刚写的东西，去改上一层的板书多半是它记错了上下文。

### 4.6 文件约定

BLS 正文不以工具参数的形式长期存在，而是**先写成文件、再按文件名推送**：

| 项 | 约定 |
|---|---|
| 目录 | `<workspace>/learn/lessons/`。插件首次写入时自行 `mkdir -p`，**不去改动宿主的 vault 初始化**（宿主的 `vault-init` 只建 `materials/` `notes/` `exercises/` `templates/` 与 `learn/progress.md`） |
| 扩展名 | `.bls`。**刻意不用 `.md`**：BLS 的 `>>` 会被 Obsidian 当引用渲染、`say <<` 会被当普通段落，看上去像文件坏了；`.bls` 在 Obsidian 里以纯文本打开，用户可以放心手改 |
| 编码 | UTF-8、无 BOM、`\n` 换行 |
| 粒度 | **一个文件 = 一层剧本**。一节课 = 一组文件 + 插件记录的顺序（见第 14 节） |
| 大小 | 单文件 ≤ 64 KiB（与 48000 字符的剧本上限同量级） |
| 文件名 | 裸文件名，须匹配 `^[A-Za-z0-9._\-\u4e00-\u9fa5]{1,48}\.bls$`，**不含任何路径分隔符** |
| 覆盖 | `write_lesson` 同名直接覆盖，返回值里标注「已覆盖」，便于模型修正写坏的剧本 |

**为什么是"一个文件一层"而不是"一个文件一节课"**：BLS 目前没有分节标记，一文件一层不需要给语法再加关键字；一节课的顺序由插件记录（第 14 节）。若后续希望一节课一个文件，得给 BLS 加一个层分隔标记——那是语法层面的改动，现在不做。

## 5. 工具接口

### 5.1 工具清单

| 工具 id | 用途 | `risk` | `modes` |
|---|---|---|---|
| `better-lessons_write_lesson` | 把 BLS 正文写入 `learn/lessons/<file>`（同名覆盖） | 见下 | `["learn"]` |
| `better-lessons_push_script` | 按文件名读取剧本并推送（打断当前播放） | `safe` | `["learn"]` |
| `better-lessons_lesson_list` | 列出 `learn/lessons/` 下的剧本文件 | `safe` | `["learn"]` |
| `better-lessons_status` | 查询课堂当前状态（是否开着、当前文件名、第几步、板书全文） | `safe` | `["learn"]` |
| `better-lessons_close` | 关闭课堂窗口 | `safe` | `["learn"]` |

`write_lesson` / `push_script` / `close` 为 `effectKind: "mutation"`，`lesson_list` / `status` 为 `"read"`；均 `verificationPolicy: "none"`。

`lesson_list` 的存在理由：回放要求先知道"有哪些剧本"，模型也需要先看到已有文件才知道该续写还是新建。Provider 会注入当前课堂用到的文件，但用户手工放进 `learn/lessons/` 的剧本只能靠这个工具被发现。

**`write_lesson` 的 `risk` 取"跟随宿主既有做法"**：宿主的 `obsidian_edit` 同样是"向 Vault 写文件"的 mutation 工具，它不声明 `risk`，即默认 `safe`、免审批执行。本插件跟随同一做法，让写剧本不打断课堂节奏——写入范围被限制在 `learn/lessons/`，且都是插件自己创建的文件。若要更保守，可以声明 `risk: "fs-write"`，代价是每次写盘前可能弹一次审批，课堂节奏会被打断。

### 5.2 两个核心工具的 schema

**`write_lesson`**

```ts
{
  id: "better-lessons_write_lesson",
  name: "写课堂剧本文件",
  description:
    "把一段讲解写成 BLS 剧本并保存到工作区的 learn/lessons/ 目录。" +
    "格式见 system context 的《BLS 格式说明》。同名文件会被覆盖。" +
    "写完必须紧接着调用 better-lessons_push_script 推送，否则课堂上不会看到任何东西。",
  enabled: true,
  effectKind: "mutation",
  modes: ["learn"],
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "剧本文件名，必须以 .bls 结尾，不含路径分隔符。建议「主题-序号-要点.bls」，如 判别式-01-引入.bls。",
      },
      script: {
        type: "string",
        description: "BLS 剧本正文。对白写在 say 块里（一行一句），板书写在 board 块里，改板书用 board replace，清板用 board clear。",
      },
    },
    required: ["file", "script"],
  },
  async execute(args, ctx) { /* 见 5.3 */ },
}
```

**`push_script`**

```ts
{
  id: "better-lessons_push_script",
  name: "推送课堂剧本",
  description:
    "按文件名读取 learn/lessons/ 下的剧本，推送到黑板窗口演出。" +
    "当课堂窗口已开启且用户插话时，必须走「write_lesson 写剧本 + push_script 推送」，" +
    "不要在聊天框里只回文本。",
  enabled: true,
  risk: "safe",
  effectKind: "mutation",
  modes: ["learn"],
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "要演出的剧本文件名，必须已存在于 learn/lessons/。",
      },
      interrupt: {
        type: "string",
        enum: ["interrupt", "append"],
        description:
          "interrupt（默认）：打断当前播放并优先演这一层；" +
          "append：不打断，排到当前播放结束之后。",
      },
      transitionHint: {
        type: "string",
        description: "可选。回到被打断的那一层时显示的过渡文案，如「我们回到刚才那道题」。",
      },
    },
    required: ["file"],
  },
  async execute(args, ctx) { /* 见 5.3 */ },
}
```

`push_script` 不再接收剧本正文——正文只存在于文件里，这是"文件名即剧本身份"的前提。

### 5.3 `execute` 的硬性实现约定

1. **首行同步发送**。不要在 `webContents.send` 之前 `await` 任何东西。宿主对同会话并发 run 抛 `SESSION_RUN_ACTIVE`，渲染端会走"终止旧 run 并重开"，旧 run 会被 abort，`ctx.signal` 随之触发；若发送前有 await，会出现"剧本推了一半"的撕裂状态。
2. **自己做参数校验**。主聊天路径只做 `JSON.parse` 且失败回落 `{}`，`required` 不会被强制。`args.file` / `args.script` 缺失时返回一段可直接抄的样板与合法示例（样板是 `prompts.cjs` 的 `SAMPLE_SCRIPT`，§6.1b），而不是抛异常。
3. **文件名必须过白名单校验**。`file` 直接来自模型，而插件有完整 fs 权限，所以在 `path.join(root, "learn", "lessons", file)` 之前必须验证：匹配 4.6 的正则、不含 `/` 与 `\`、不以 `.` 开头，并对 `path.resolve` 后的结果做前缀比对，确认仍在 `learn/lessons/` 之内。这一条是**硬性要求**，不是防御性编程。
4. **工作区根目录从两处取**。工具内部直接用 `ctx.resolvedWorkspaceRoot`；`open()`、IPC 处理器、回放这些不在工具调用栈里的场景用 `await ctx.deps.workspace.getBinding(conversationId).root`（`deps` 需声明 `workspace`）。两处都拿不到时返回明确错误「该会话未绑定工作区」，**不静默降级到插件私有目录**——否则剧本会写到一个用户永远看不见的地方。
5. **读盘失败要给可行动的文案**。`push_script` 遇到文件不存在时返回「learn/lessons/ 下没有 <file>；当前可用：a.bls、b.bls」，而不是一句"读取失败"。
6. **落盘后立即解析校验，解析失败不留坏文件**。`write_lesson` 写完先解析一遍：0 个有效 step 时**删除刚写的文件**并把 warning 返回给模型，避免 `learn/lessons/` 里堆积无法演出的残次品。
7. **返回值要短**。工具结果超过 30000 字符会被按 12000 头 + 8000 尾截断，事件 preview 只保留 200 字符。剧本走文件与 `send`，返回值只回一句人类可读的确认，例如 `已推送《判别式-01-引入.bls》，共 9 步（当前课堂栈深 2）`。
8. **窗口不存在就开**。`execute` 内若该 room 无窗口，先 `open()` 再发送；`open()` 是异步的，但此时已不该 await——把发送挂到 `open()` 的 promise 上，通过 `onDispose` 兜住泄漏。
9. **按 `ctx.conversationId` 分房间**。一个插件实例服务所有会话，绝不能共用一个帧队列或一块黑板。
10. **`append` 语义不打断**：`interrupt: "append"` 时把新层排到帧队列末尾，`cursor` 保持不动。

## 6. Prompt Provider：这套方案能成立的前提

### 6.1 为什么必须有 Provider

课堂插话的入口在宿主对话框，而窗口**拿不到**宿主的 run 事件。模型如果只回文本、不调工具，窗口就毫无反应。唯一能在请求侧施加约束的位置是 Prompt Provider——好在它的 `provide` 能拿到**当前用户输入原文**与 `conversationId`。

Provider 的输入契约：`{ source, mode, userText, conversationId, channel, signal }`，单次最多等 2 秒，单项最多 16000 字符。贡献内容进入每轮变化的 runtime context，**不写入稳定提示词前缀，不会破坏宿主的基础提示词缓存**。

### 6.1b 提示词都写在 `prompts.cjs`

给模型的每一句措辞集中放在 `prompts.cjs`，**`index.cjs` 只决定"什么时候把它送出去"**。一共三种形态，别混用：

| 形态 | 出口 | 频率 |
|---|---|---|
| `BLS_FORMAT_SPEC` | Provider 返回值的最前面 | learn 模式**每一轮** |
| `buildClassroomBrief()` | 接在 `BLS_FORMAT_SPEC` 之后（同一轮、同一个 context） | 仅当该会话有活跃 room |
| `buildFallbackRequest()` | 插件自己发的一次 `generateText`，**不进宿主** | 兜底稽核命中时（§6.3b） |

`SAMPLE_SCRIPT`（一段可照抄的最小正例）走的是第四条路：它拼在 `write_lesson` 的**参数校验报错**文案后面返回给模型。它是"工具返回值"，但内容本身是格式说明，所以和 `BLS_FORMAT_SPEC` 放在一起——BLS 语法一改，这两处必须同时改。

**有意不搬进去的东西**：工具名与参数的 `description`（和 `inputSchema` 交织，拆开会让"读一个工具的定义"变成翻两个文件，属 §5.2）、工具返回值的错误与回执文案（必须与参数校验的行号绑在一起，§5.3）、窗口与面板的界面文案（给用户看的）。

每个提示词上方都有一段 `【调用时机】` 注释，写清楚它在什么时刻、以什么形式到达模型眼前；改语气、加约束、调措辞只改 `prompts.cjs`。

### 6.2 两类注入内容

**（a）常驻：BLS 格式说明**（`modes: ["learn"]`，无论课堂是否开启都注入）

给出 4.2 的语法表 + 下面这些硬规则：

- 剧本先用 `better-lessons_write_lesson` 写成 `learn/lessons/<名字>.bls` 文件，**再**用 `better-lessons_push_script` 按同一个文件名推送；写完不推等于什么都没发生；
- 文件名用「主题-序号-要点.bls」，序号体现顺序（`判别式-01-引入.bls`、`判别式-02-求根.bls`；插在两者之间的补充用 `01.1`）；
- 对白写在 `say <<` 块里，**一行一句**（不要把小半段话挤在一行），块内不要留多余空行；
- 板书正文是 markdown，只能写在 `board <<` 块里；块外不要出现 markdown 标题（BLS 没有注释语法，块外的散行会被当成无法识别的行丢掉）；
- 要擦掉、改写或强调已写在黑板上的东西，用 `board replace <旧内容> -> <新内容>`，**不要在块里把整块重画一遍**；`旧内容` 必须**逐字**来自 system context 给出的「当前板书」，包含标点与空格；
- 正文里不要写 ASCII 箭头 `->`，要写 `→`。

这是"约定一种文本格式"的落点——不修改宿主的 `prompts/learn_system.md`，契约随插件的启停而生效/失效。

**（b）条件：课堂现场状态**（仅当该 `conversationId` 有活跃 room）

```js
ctx.registerPromptProvider({
  id: "classroom",
  modes: ["learn"],
  sources: ["conversation"],
  provide({ userText, conversationId, signal }) {
    if (signal && signal.aborted) return "";
    const room = rooms.get(conversationId);
    if (!room) return BLS_FORMAT_SPEC;      // 没有课堂：只给常驻说明
    room.lastUserText = String(userText || "");   // 留给兜底补剧使用
    const head = room.frames[0];
    const progress =
      head && head.type === "layer"
        ? `正在播放《${head.layer.file}》第 ${head.layer.cursor + 1}/${head.layer.steps.length} 步`
        : head
          ? `即将播放一层过渡（${head.kind === "in" ? "进入新推的内容" : "回到被打断的那层"}）`
          : "当前没有正在播放的剧本";

    return `${BLS_FORMAT_SPEC}\n${buildClassroomBrief({
      progress,
      frameCount: room.frames.length,
      lessonFiles: room.lessonFiles,
      boardText: board.boardText(room.board),
      userText,
    })}`;
  },
});
```

上面这段 `provide` **只负责取值**（进度怎么描述、板书怎么取），措辞全在 `buildClassroomBrief` 里（§6.1b）。

板书全文是**必须**注入的：`board replace` 靠内容匹配定位，模型必须先看到黑板现在写着什么，才可能引用出逐字精确的「旧内容」。板书很长时按 `BOARD_INJECT_LIMIT`（12000 字符）截断，**优先保留末尾**——新写的板书在下面，也更可能是这次要改的目标（为什么不是 Provider 契约里的 16000：那 16000 是整段返回值含常驻说明的上限，留出余量更稳）。

「这节课已用过的剧本文件」是**回放的索引**：有了它，模型下一轮可以主动重放某一节（`push_script({file})`），也避免它反复新建同名文件。

`provide` 里**没有任何 await**，纯同步读取内存状态，稳在 2 秒预算内。

### 6.3 兜底：模型漏调工具时

Provider 是"软约束"，模型仍可能不听话。用宿主事件做轮次稽核：

| 事件 | payload 关键字段 | 用途 |
|---|---|---|
| `host:turn:started` | `runId`、`mode`、`source`、desktop 分支带 `conversationId` | 标记本轮开始 |
| `host:tool:finished` | `runId`、`toolId`、`status`、`risk` | 确认本轮是否**成功**推过剧本 |
| `host:turn:finished` | 同上 + 终态；成功终态带 `finalMessageId` | 收尾对账 |

**对账逻辑**：某轮 `source === "desktop"`、`status === "success"`、`mode === "learn"`，却没有任何 `better-lessons_push_script` 的**成功**记录 —— 这还不算"模型漏了"，还得同时满足下面三条：

| 前置条件 | 为什么 |
|---|---|
| 该 `conversationId` 有 room，且 `room.frames.length > 0` | 课堂得正开着、且有内容在播。空课堂（还没讲 / 已经讲完）沉默是正常的 |
| 窗口已打开，且 `boundConversationId === conversationId` | 用户根本看不到这一间课堂的话，补了反而会把窗口从别的会话硬拽过来 |
| 该会话绑定了工作区 | 兜底剧本要落盘 |

满足之后，两种漏法分开处理：

**（a）写了文件但忘了推** → 直接把这个文件推出去，**不需要模型，结果最确定**。
判定靠插件自己记的账：`write_lesson` 执行成功时往本轮（按 `runId`）记下 `wroteFile`。之所以要自己记，是因为 `host:tool:finished` **不带参数**，事件里看不出写的是哪个文件。这一层是模型自己的内容，**不标 `fallback`**，只额外弹一条提示。

**（b）对课堂一个工具都没调过** → 才用 `generateText` 补一段最小剧本：

```js
const request = buildFallbackRequest({ userText: room.lastUserText });   // prompts.cjs
const text = await ctx.deps.llm.generateText(request.messages, request.options);
const file = `补充-${Date.now()}.bls`;         // 名字唯一，且落在 §4.6 的白名单内
lessons.writeLesson(root, file, sanitizeGeneratedScript(text));
```

`maxTokens: 512` 与「写 2-4 步」是**成对**的约束，所以由 `buildFallbackRequest` 一并返回（`prompts.cjs`）：调大了浪费，调小了这个剧本会被截断成半截——解析必然失败，然后被删掉。这一条**不进宿主**，是插件自己发的一次调用。

`generateText` 的返回要过一道清洗再落盘：模型爱把正文包进代码围栏、或在前面加一句「好的，这是剧本：」。做法是找到第一个以 `meta` / `say` / `board` 开头的行、从那里截断，再删掉结尾的围栏行。

**（c）模型调过课堂的其它工具**（`status` / `lesson_list` / `close`，或一次**失败**的 `write_lesson`）→ **什么都不做**。

这一条是刻意加严的：原始设计写的是"任何没有成功推送的 learn 轮次都补"，那会让用户每问一个与课堂无关的问题（比如"帮我整理一下笔记"）都额外收到一段凭空生成的剧本。**乱补比不补更烦人**——模型调过课堂的工具，说明它知道课堂存在，是有意识地没动它。

**冷却**：同一会话两次兜底补剧至少间隔 30 秒，避免模型连续几轮不接课堂时每轮都补一段。

**兜底必须复用同一条写盘路径**：兜底剧本同样落盘成 `.bls` 文件，它在回放里与模型产的剧本没有任何区别，不会变成一段只能看一次、无法重演的内容。若生成的内容解析不出任何有效 step，**与 `write_lesson` 同一个原则删掉那个文件**，不把残次品留在 `learn/lessons/` 里。

兜底补剧的来源标记：`layer.fallback = true`，`advance` 每帧把 `fallback` 一并返回（回放的响应也带队首那一层的 `fallback`），窗口在**右上角**显示一个轻标记，让用户知道这段不是主模型说的。右上角是空的（提示条在顶部中间、黑板在左侧、讲述立绘在右下）。

**事件是旁路通知**：宿主不等插件监听器，插件需自行排队处理。另外 `host:turn:finished` 的 payload **不含对话文本**，所以兜底所需内容必须靠 `provide` 阶段自己留存——这正是 6.2 里 `room.lastUserText = userText` 的原因。

实现上按三个阶段分工，别把异步动作塞进监听器：

- `turn:started` / `tool:finished` 里**只做同步记账**（`runId → { conversationId, mode, classroomToolUsed, pushed, wroteFile }`），因为单个监听器超 5 秒会被记录，不能占着宿主的发布路径；
- `turn:finished` 里做判定，命中才把兜底动作**异步**抛出去；
- 账本按 `runId` 在 `turn:finished` 时立即删除（`turn:finished` 万一丢了也不能让它无限增长，所以另设 20 条上限）。

**这一轮的任何事件都没看到就不猜**：账本只在两种情况下建立 —— 看到 `turn:started`（拿得到 `conversationId` / `mode`），或看到本轮某个课堂工具的 `tool:finished`（拿得到它是怎么处理课堂的）。两条都没有时（比如插件在本轮中途才启用）直接放弃兜底。宁可漏补，也不要在信息不全的情况下补错——补错的代价是往课堂里塞一段用户没要的内容。

只看到工具事件也够：记账靠的本来就是工具事件，缺的 `conversationId` / `mode` 可以从 `turn:finished` 的 payload 补齐。

## 7. 播放状态机

### 7.1 数据结构

```ts
type Frame =
  | { type: "layer"; layer: Layer }
  | { type: "transition"; kind: "in" | "out"; title?: string; text: string };

type Room = {
  conversationId: string;
  frames: Frame[];        // 待播放队列；frames[0] 是当前正在播放的帧
  board: Board;           // 黑板当前状态（第 8 节）
  boardOwner: string | null; // room.board 反映的是哪一层的增量；null = 空板（7.4）
  lessonFiles: string[];  // 本节课推过的剧本文件，按推送顺序 —— 回放的播放列表
  lastUserText: string;   // Provider 阶段留存，供兜底补剧使用（6.3）
};
```

窗口不在 Room 上：一个插件实例只有一个窗口，它归主进程模块持有，Room 只管"这节课演到哪了"。

队列即栈：**栈顶就是 `frames[0]`**。这样"打断压栈"和"恢复弹栈"统一成对队列首部的插入/移除，只有一种数据结构要维护。当前播放进度就存在 `frames[0].layer.cursor` 上，不需要额外快照。

### 7.2 帧序列示例

初始推送 A（3 步）：

```
frames = [ A(cursor=0) ]
```

播到 A.2 时用户插话，推送 B：

```
frames = [ Trans_in, B(cursor=0), A(cursor=2) ]
                ↑ 清板 + 过渡文案，B 演完要回到 A
```

B 播完：

```
frames = [ Trans_out, A(cursor=2) ]   → 清板，瞬时重绘 A 的 0..1 步，从第 2 步续播
```

此时若又插话推送 C，则：

```
frames = [ Trans_in, C, Trans_out, A(cursor=2) ]
```

再次回到 A 时是同一个算法，无需特殊分支。

### 7.3 推进算法

`onClick()`：

1. 取 `frames[0]`。
2. 若是 `transition` 帧：呈现清板动作与过渡文案，`frames.shift()`，本次点击结束。
   **过渡帧本身要占一次点击**，不能在同一次点击里被连带消费掉——否则清板和文案会和下一层的第一个 step 挤在同一帧里，文案根本来不及被看见（模型给的 `transitionHint` 也就白给了）。
3. 若是 `layer` 帧：
   - `cursor >= steps.length` → 本层结束：`frames.shift()`；若 `frames[0]` 存在则 `frames.unshift(makeTransition("out"))`，然后**继续循环**去把它作为本次点击的结果返回；否则播放"下课"收束帧。
   - 否则执行 `steps[cursor]`，`cursor++`。
4. 任何时刻 `frames.length > MAX_FRAMES`（默认 9，约 3 层 + 过渡帧）时，从**队尾**丢弃最旧的未播放层（连带它后面的过渡帧），并在窗口角落提示"课堂内容较多，已折叠较早的部分"。绝不丢 `frames[0]`。

### 7.4 打断与恢复的精确语义

**打断（收到 push）**

- 若 `interrupt: "interrupt"`（默认）且 `frames[0]` 是 layer：
  - `cursor` 就地冻结（它一直都在 `layer` 对象上，不需要额外快照）；
  - `frames.unshift(makeTransition("in", transitionHint))` —— 该过渡帧负责**清板**与文案；
  - `frames.splice(1, 0, newLayer)`。
- 若 `frames[0]` 已经是过渡帧（前一次打断还没播）：**不再插新的过渡帧**，直接把新层插到它后面（`splice(1, 0, newLayer)`）。否则会出现连续两帧过渡；而"最新的打断优先"本来就该直接顶上去。
- 若 `interrupt: "append"`：`frames.push(newLayer)`，不动当前播放。

**恢复（layer 帧播完）**

1. `frames.shift()`，并插入 `transition("out")` —— 它同样负责清板；
2. 这次点击的结果就是这个过渡帧：用户看到的是**擦干净的黑板**，而不是"擦干净又立刻恢复"。
3. 下一次点击真正要演被打断那层的步时，才做**瞬时重绘**（§8.3）：
   - 清空黑板，把 `layer.boardOps` 中 `stepIndex < cursor` 的操作**无动画**地依次 `apply`；
   - 立绘直接回**休息态**（讲述），**三拍与跳动都不演**（第 9 节，根元素挂 `data-instant`）；
   - 然后从 `cursor` 起恢复带动画播放。

**为什么重绘要晚一拍**：清板和重绘如果发生在同一帧，用户看不到擦板动作，"回到刚才"就退化成了画面闪一下。晚一拍的代价只是多一次点击。

**`boardOwner` 是这套时序的开关**：Room 记住"当前黑板反映的是哪一层的增量"，每次要演某层的步之前检查一次——不一致就先按断点重绘。这样"插话回来""回放跳到某节""跨会话切绑定"三种路径共用同一段逻辑，不需要各自的特殊分支。

**为什么必须"瞬时重绘"**：如果重绘也走动画，用户每次插话回来都要干等板书从头演一遍，"回到刚才"的体感会变成"重新看一遍"。

**重放的确定性**：`boardBlock` 是纯追加、`boardReplace` 在单行内做内容替换（不增删行）、`boardClear` 清空——三者在顺序重放下的结果与首次播放完全一致，所以瞬时重绘不需要存黑板快照，只存 `boardOps` 就够。

### 7.5 边界规则

| 场景 | 处理 |
|---|---|
| 同轮 LLM 发起多个 push（工具恒串行，会连收多个） | 按 `runId` 归并为一层：合并 `steps`，后到的接在尾部；避免栈被瞬间冲掉 |
| 空剧本 / 解析后 0 步 | 工具侧就拒绝，不产生 Layer |
| 窗口在播放中被关闭 | room 保留（`win = null`），下次 push 时重开并只播新层，旧层丢弃 |
| 窗口重开但 room 不存在 | 走持久化恢复（第 13 节） |
| 剧本文件被用户删除后又推送它 | `push_script` 返回"文件不存在 + 当前可用清单"（5.3 第 5 条） |
| 剧本文件被用户手工改过 | 文件是唯一真相源，下次推送按新内容演出；已在播放的层不受影响（`steps` 是快照） |
| 用户连点过快 | 点击节流 120ms；仍在动画中时点击排队而非丢弃 |

## 8. 黑板模型

### 8.1 数据结构

黑板就是一篇 markdown 文档：

```ts
type Board = {
  lines: string[];   // 一篇 markdown 文档的行
};
```

整个 `Board` 由一组纯函数操作，**校验器、播放器、断点重绘器共用同一份实现**：

```ts
function apply(op: BoardOp, board: Board): void {
  switch (op.kind) {
    case "boardBlock":
      board.lines.push(...op.lines);
      break;
    case "boardReplace": {
      const text = board.lines.join("\n");
      const at = text.indexOf(op.from);     // 找不到 → 整步跳过（4.5）
      if (at < 0) break;
      board.lines = (text.slice(0, at) + op.to + text.slice(at + op.from.length)).split("\n");
      break;
    }
    case "boardClear":
      board.lines.length = 0;
      break;
    case "say":
      break;   // 对白不动黑板
  }
}
```

替换在**单行内**完成（`from` 与 `to` 都不含换行），因此 `boardReplace` 既不增删行、也不改变模板的其余部分——这是重放确定性的来源（7.4）。

### 8.2 渲染与行级动画

**渲染单位是整篇文档，不是逐行独立渲染**——否则跨行的列表、表格、引用会被切断。渲染流程：

1. `board.lines.join("\n")` → markdown → HTML，整体铺在黑板上；
2. 同时按"块级元素"切出文本的归属，用于把 `boardReplace` 命中的那段文本映射回 DOM 节点（列表项、段落、引用行是可对齐的；表格/代码块视为一个整体，命中其中任意位置时对整块做动画）；
3. 动画只施加在**本次操作涉及的行/块**上：
   - `boardBlock`：新追加的行依次淡入 + 轻微粉笔书写位移；
   - `boardReplace`：命中的那一段闪一次强调底色（无论内容变成什么，这样"擦除"也有可见的擦除动作）；
   - `boardClear`：整块做一次擦除/淡出。

**动画目标的定位方式**：窗口**不做全文 diff**，而是靠"这一步是什么类型"直接算目标，再用行区间标注回 DOM：

- 行区间由 markdown-it 的 renderer 规则在**渲染时**写成 `data-line="start-end"`（取自 token 的 `map`），而不是渲染完再逐个配对。
- **粒度必须下沉到列表项与表格行**（`list_item_open` / `tr_open`）。这条是实测改出来的：一整段 40 项的 markdown 列表渲染出来只有一根 `<ul>`，如果只标到块一级，"第 20 行被强调"就只能定位到整根列表，于是"滚到新增内容底部""把强调行带到视野顶部"两个动作全部失准。`paragraph_open` / `heading_open` / `blockquote_open` / `table_open` / `hr` 一并标注。
- **代码块单独处理**：markdown-it 的 `fence` 规则在围栏**带语言**时（```` ```cpp ````）会另造一个只含 `class` 的假 token 去渲染 `<code>`，挂在真 token 上的属性会被直接丢掉。所以代码块改成渲染完把 `data-line` 注入 `<pre>`。
- 定位时取**行区间最小**的那个元素（最精确命中），于是"第 23 行"落在第 20 个 `<li>` 上而不是整根列表。
- 净化必须放行 `data-*`（`ALLOW_DATA_ATTR: true`），否则标注会被 DOMPurify 静默剥掉。这不降低安全性：markdown-it 关了 `html`，模型写的原始标签一律转义，输出里的 `data-*` 只可能来自我们自己的 renderer 规则。
- `boardBlock`：新行从"渲染前的行数"开始 → 给命中新行的元素打 `bl-enter`，且**只打最外层**（一段新追加的列表里 `<ul>` 与 40 个 `<li>` 都命中，两层一起淡入会看着发虚）；
- `boardReplace`：在**渲染前的**板书里 `indexOf(step.from)` 换算出命中行号（替换不增删行，行号在前后稳定）→ 只给那一个元素打 `bl-flash`；
- `boardClear`：板面整体一次擦过感。

用 step 类型而不是做 diff，是因为主进程已经把"这一步干了什么"告诉窗口了，diff 反而会引入歧义（比如同一段文字被改写前后恰好相似）。

markdown 渲染走 vendored 的 `markdown-it`（选型见 3.3），对白与板书共用同一个实例、同一套行内规则。**只用标准 markdown，不引语法扩展插件**。BLS 不提供独立的 highlight 关键字，强调完全由标准 markdown 承担，主用两种：

- `**加粗**` → 加粗 + 提亮字色，这是**强调的默认写法**；
- `> 引用` → 左侧色条 + 稍大字号，适合整行强调。

净化白名单必须覆盖 markdown-it 能产出的全部标签（漏一个，那段内容会被 DOMPurify 静默剥掉，而不是报错）。删除线在 markdown-it 里渲染成 `<s>` 而不是 `<del>`，是个容易漏的点。`img` 则**故意不放行**：板书不需要图片，而放行等于让模型写的内容去发远程请求。

### 8.3 断点重绘

```
board.lines = []
for (op of layer.boardOps) if (op.stepIndex < layer.cursor) apply(op, board)
```

因为**每一层都从空黑板开始**（4.5 的不变式），重放不需要任何前置快照，从空板起放就够了。

**触发时机是"晚一拍"**：不是过渡帧那一刻，而是下一次真正要演被打断那层的步之前（7.4）。判定靠 Room 的 `boardOwner`——它和当前要演的层不一致就重绘一次。

**重绘是主进程的事，动画是窗口的事**：`apply` 只算"最终该是什么内容"，与动画无关；窗口拿到新的 `boardText` 后按这一步的类型决定给哪个块加动画（8.2）。这样黑板状态的真相只有一处（主进程），窗口只负责表现。

### 8.4 为什么不做分层 overlay

另一种更"正确"的做法是每层只存增量、渲染时按帧栈顺序重放到当前层。它的优势是恢复后黑板内容**完全保留**（包括被新层写上的东西）。不选它的原因：

1. 插话场景下，学生希望看到的是"回到老师刚才讲的那块板"，而不是一块混着两段讲解的板；
2. `board replace` 用的是**内容匹配**。两层板书叠加渲染时，模型给的「旧内容」可能匹配到另一层写的东西上，等于改错了黑板；
3. 过渡帧清板的视觉收束本来就符合"翻页/擦板"的课堂直觉。

代价是新层播放期间旧板书不可见。这是有意为之的取舍。

### 8.5 黑板内容双向可滚动

半屏窗口下黑板的可视面积很小，而一堂课的板书很容易写满，所以**板书面布是双向可滚动的**（`overflow: auto`）：

- **只有面板滚动**：黑板木框、教室背景、立绘、对话框都固定，滚动条只出现在黑板内边缘，不做整页滚动。
- **横竖都要能滚**：代码块、长公式、表格天然很宽，`overflow-x: auto` 是必须的；配合代码块的 `white-space: pre`，横向滚动是唯一的正确解法。
- **滚动条细、半透明、覆盖式**（`scrollbar-width: thin` 与 `::-webkit-scrollbar`），不在黑板上切出一道显眼的浅色栏杆。
- **新内容自动入视野：两种动作、两个落点**（实测调出来的，都写在 ui.html 的 `animateBoard` 里）：
  - `boardBlock` 追加 → 找到**新增最后一行**所在的元素，量出它的底边超出视野多少就把 `scrollTop` 补多少；已经看得见就一点都不动。新写的板书要"跟着粉笔走"，眼睛跟着粉笔往下走才对。
    **不能用 `scrollIntoView("nearest")`**：40 项列表渲染出来只有一根 `<ul>`，它比视野还高、顶边本来就可见，`nearest` 会判定"不用滚"，用户于是什么也看不到（实测踩过）。所以要直接量矩形。
  - `boardReplace` 命中 → 对命中的那个元素调 `{ block: "start" }`，把那一行带到视野**顶部**。强调是"看这里"的手势，从顶部往下读最自然。
  - 两者都用 `inline: "nearest"`：横向只在真的看不见时才动，不抢纵向的戏。
  - **已知限制**：标注只到元素一级，没有下沉到行内元素（`<td>` / `<code>` 内部），所以强调一张宽表格里的某一列时，纵向会把那**一行**带到顶部，但**不会横向滚到那一列**。要修得继续往下沉一层。
- **重绘期间不滚动**：断点重绘（8.3）与回放（第 14 节）期间冻结滚动，等重绘结束后再统一恢复一次位置。
- **滚轮归黑板**：鼠标在黑板区域内滚轮只滚黑板，不冒泡去带动别的层；对话框文本区自己是独立滚动容器。

滚动是**渲染层的属性**，不进入 BLS：剧本里没有任何"翻页"指令，板书一直往下写，看不看得见由滚动决定。

### 8.6 黑板上的"空"有三种，别混

板书正文为空时，黑板中央那句占位提示（`#boardEmpty`「等待剧本推送…」）**只在第一种情况下出现**：

| 情况 | 黑板 | 对话框 | 为什么 |
|---|---|---|---|
| **开场态**：窗口刚打开、这一节课什么都没收到 | 显示「等待剧本推送…」 | 「点『📂 打开剧本』挑一个剧本，或者等昔涟推给你。」 | 用户面对一个全空的窗口，得知道能干什么 |
| **推送后未点击**：模型推来一节课，第一帧还没铺开 | 什么都不显示 | 「昔涟推送了一节课给你，点击进行下一步。」 | 内容**已经**到了，说"在等推送"是错的；空板是"还没铺"，不是"什么都没有" |
| **清板后**（`board clear` 或过渡帧清板） | 什么都不显示 | step 自带的对白 / 过渡文案 | 擦干净是**演出的一部分**，这时候跳出"在等推送"最出戏 |

实现上是一个只能向一个方向翻转的开场态标志（`ui.html` 的 `idleEmpty`）：窗口默认处于开场态，**一旦收到过推送、回放过、或真的演过一帧，就永久退出**，此后黑板空就是真的空。四处翻转点：

- `push` 事件——顺带把对话框换成「点击进行下一步」（只在仍是开场态时换，播放中插话推送不会顶掉当前那一句对白）；
- 回放成功（`requestReplay`）；
- `applyFrame` 收到任何非 `done` 的帧（兜底：推送事件万一没送达窗口，第一次点击也能纠正过来）；
- 窗口重开时从 `state` 读到该房间**队列里还有帧**（`frames > 0`），且顺手把对话框也换成「点击进行下一步」。判据**只认"还有没播完的东西"，不认"这个房间讲过课"**：一节课播完（`frames` 清空）之后再打开窗口，用户手里确实什么都没有了，就该老老实实回到开场态——否则窗口会对着空荡荡的屋子说"昔涟推送了一节课给你"，而昔涟其实什么都没推。

反过来说，**`done` 不翻转开场态**，而且要分两种处境：

- 队列空后再点还是 `done`（7.5），若在 `done` 里翻转，"从没收到内容时点一下"就会莫名其妙退出开场态；
- 所以开场态里的 `done` **直接返回**，连「这节课先到这里」都不写——这一节课从头到尾什么都没有，点一下不是"收课"，而是"还没有课可上"，该保留的是开场引导而不是一句收课词。

## 9. 美术素材与立绘

### 9.1 素材全部由插件自带

课堂窗口**不读取宿主仓库里的任何资源**。所有美术素材放在插件自己的 `assets/` 下，用相对路径 `loadFile` / `file://` 引用：

| 文件 | 用途 | 建议尺寸 | 体积预算 |
|---|---|---|---|
| `assets/classroom-bg.jpg` | 教室背景，铺满窗口底层 | 1920×1080 | ≤ 800 KiB |
| `assets/board.jpg` | 黑板本体，叠在教室背景之上 | 1600×900 | ≤ 500 KiB |
| `assets/dialog-bg.png` | 对话框底板（九宫格拉伸） | 1200×300 | ≤ 300 KiB |
| `assets/cyrene-talk.png` | 立绘：讲述（**半身**，右下近景） | 900×1100，透明底 | ≤ 1.5 MiB |
| `assets/cyrene-write.png` | 立绘：板书（全身，黑板前） | 900×1400，透明底 | ≤ 1.5 MiB |
| `assets/cyrene-erase.png` | 立绘：擦板 主帧（全身，黑板前） | 900×1400，透明底 | ≤ 1.5 MiB |
| `assets/cyrene-erase-swing.png` | 立绘：擦板 **挥舞差分**（只改手臂） | 900×1400，透明底 | ≤ 1.5 MiB |

总量控制在 8 MiB 以内（ZIP 导入上限是 50 MiB / 2000 条目，余量充足）。立绘用透明底 PNG；要更小可换 WebP，Electron 原生支持。

立绘的体积预算从 500 KiB 放宽到 1.5 MiB：900×1400 的 RGBA 精细立绘压到 500 KiB 会明显掉质量，而这个尺寸本身只有显示尺寸的 2 倍左右，没有继续压的必要。**约稿要求见 `assets/约稿要求.md`**（显示环境、四张图的构图与表演要求都在那里）。

**为什么坚持自带素材**：读宿主的 `src/renderer/public/` 或 `dist/renderer` 属于实现细节依赖，宿主重命名一个目录插件就整个废掉；而且 galgame 需要的是"教室 + 黑板 + 讲述/板书/擦板立绘"这类宿主根本没有的素材，硬蹭只会两头不讨好。自带的代价只是几 MB 打包体积。

**降级**：素材文件缺失或加载失败时，退回**纯 CSS 程序化占位**（黑板用深绿渐变 + 木框，教室底色用浅色渐变，立绘用深色半透明剪影），版面结构保持不变。刻意不做"读宿主素材"的第二档降级——那条路已被明确排除。

### 9.2 立绘：两槽四图，一次点击一次演出

BLS 里没有情绪关键字，立绘完全由**当前正在执行什么类型的 step**推导，规则是纯函数 `stageOf(step) → Stage`。

**关键：立绘不是"持续状态"。** 休息态永远是右下角的讲述；板书与擦板是**每次点击的一次性造访**——她走过去、停一下、自己走回来。所以不存在"停在某个姿态不动"，也不会出现"连续两步都站在黑板前"。

**角色形态是哀丽秘榭的小昔涟（粉色短发）**，不是成年形态（官方成年形态的婚纱 / 头纱 / 九朵玫瑰那套设计不适用于这四张）。

| 槽 | 位置 | 素材 | 何时出现 |
|---|---|---|---|
| `talk` 讲述 | **右下角**，半身近景 | `cyrene-talk.png` | **休息态**：`say` step、课后 `done`、开场、回放复位、瞬时重绘 |
| `board` 板书 / 擦板 | **黑板前**，全身远景、**完全背身** | `write` → `cyrene-write.png`；`erase` → `cyrene-erase.png` + `cyrene-erase-swing.png` | **一次性造访**：`boardBlock` / `boardReplace` → write；`boardClear` 与 `transition` 帧 → erase |

```ts
type Stage =
  | { slot: "talk" }
  | { slot: "board"; art: "write" | "erase" };
```

**两个槽可以同时存在**——交叉过渡期间就是这样（她走过去的路上两张同时在画面里），这是位置区分的前提：她"在右下角看着你说话"和"转身站到黑板前写字"是两件事，塞进同一个槽换图会变成原地瞬移。

**背身是有意的取舍**：板书与擦板这两张不承担表情表演（看不到脸），表演完全交给讲述那张和对话框文字；换来的是"她真的在黑板上写"的空间关系。所以讲述那张承担了全部情绪表达，要画得更细。

**擦板为什么要两张**：擦板是一个**动作**（挥动手臂），单张静态图会很僵。两张交替就能读成"在擦"，成本只是一张手臂差分，不需要引入逐帧动画或 Live2D。

帧队列播完（"下课"）时停在 `talk` 槽，不再切换。

### 9.3 一次点击的演出：去 → 停 → 回

全部是 DOM + CSS transition，**不引入渲染引擎、不做逐帧动画、不引入 Live2D**（3.3）。

每次点击（板书类 step）按三拍走：

| 拍 | 表现 | 时长 |
|---|---|---|
| **去** | `talk` 槽淡出 200ms，**同时** `board` 槽淡入 200ms（交叉，不是先后） | 200ms |
| **停** | `write` 静态停留；`erase` 在停留期间每 380ms 与挥舞差分交替 | write **900ms** / erase **1140ms**（380×3） |
| **回** | `board` 槽淡出 200ms，**同时** `talk` 槽淡入 200ms | 200ms |

`say` step 不走这三拍：她本来就在右下角，只**向上轻跳一次**（`translateY 0 → -12px → 0`，260ms）——让每一次点击都有即时反馈。

**跳动只由真正的 `say` step 触发**：课后（`done`）、未知 step 类型、回放复位、瞬时重绘都不跳。

这一条有具体原因：**队列排空后 `advance` 会持续返回 `done`** —— 课后用户再点多少次，回来的都还是 `done`。如果 `done` 分支也跳，她就会每点一次弹一下；而课程已经结束，她只是在原位站着，此时点击不该有任何反应（想再看一遍请用 `⟲ 本节`）。

三个时长（`SWING_MS` / `BOARD_HOLD_MS` / `ERASE_HOLD_MS`）就是**手感旋钮**，直接改窗口里的常量即可，不影响其它逻辑。

要点：

- **演出中再次点击：立刻打断上一次演出，按新的来**，不排队。窗口里的点击本来就代表"我要看下一步"，让她先演完再响应会变成"点了没反应"；而且黑板内容在这次点击里已经更新了，立绘必须跟上。
- **交叉过渡每次都播**——每次都是一次新的造访。这一点与"持续状态"版本相反：那时要避免同槽内重复淡入，现在每次都要完整演一遍。`applySlot()` 的同槽去重因此只剩一个作用：同一次演出内不重复赋值。
- **差分定时器只活在擦板停留期间**：回到讲述必须清掉，否则窗口会一直空转。
- **瞬时重绘（7.4）不演三拍**：直接回休息态（`talk`），并给根元素挂 `data-instant` 关掉所有 transition。
- **同槽内的图必须同尺寸、同锚点**（脚底对齐、中轴对称），否则换图时会"跳一下"。擦板差分图与主图尤其要严格对齐——它每 380ms 换一次，错位会非常刺眼。
- **素材缺失按槽独立降级**：某个槽的图加载失败就走该槽的剪影占位（9.1），不影响另一个槽；擦板差分缺失时只用主帧（退化成静态擦板），停留时长仍按 `ERASE_HOLD_MS` 走。
- 讲述槽与板书槽**位置接近但不等高**（11.1），去回的路上会有"她升起来站到黑板前"的位移感，这是想要的。
- **待定**：`talk` 槽在"回"的落地瞬间要不要也跳一下（现在不跳）。加与不加都是一行调用。

## 10. 边界：插件不碰笔记

**插件不生产、不读取、不写入任何笔记文件。** 这一节存在的唯一目的，是把这个边界写死，避免后续"顺手加个沉淀"。

依据：宿主 learn 模式本身就有完整的笔记能力——笔记目录 `notes/`、`learn/progress.md`、以及 `obsidian_*` 六个工具（`obsidian_edit` 可以创建、替换、追加、按章节改）。插件再去写一遍笔记，会直接和这条既有链路打架：宿主的笔记是**模型的产物**（它知道自己写了什么、能继续维护）。

因此：

- 插件不写 `notes/`、不写 `learn/progress.md`，也不把黑板快照落盘成任何"课堂记录"；
- 剧本文件（`learn/lessons/*.bls`）是插件在工作区里**唯一**的写入产物，它有明确归属：插件自己创建、自己读、自己回放（第 14 节）。笔记是另一回事，归宿主。

用户在课堂上想把板书记下来，走宿主 learn 模式的既有路径即可——让模型记，而不是让插件偷偷记。窗口默认半屏（11.1），另一半屏幕正好留给用户看宿主写好的笔记。

## 11. 窗口与 IPC 协议

### 11.1 窗口创建（默认半屏）

```js
const { screen } = require("electron");
const { workArea } = screen.getPrimaryDisplay();   // 已排除任务栏

pluginWin = new BrowserWindow({
  x: workArea.x, y: workArea.y,
  width: Math.round(workArea.width / 2),           // 左半屏
  height: workArea.height,
  minWidth: 640, minHeight: 520,
  frame: false, resizable: true, autoHideMenuBar: true,
  backgroundColor: "#00000000",                     // 透明底：圆角由页面自己画（11.3）
  transparent: true,
  webPreferences: { nodeIntegration: true, contextIsolation: false },
});
await pluginWin.loadFile(path.join(__dirname, "ui.html"));
```

**为什么默认半屏**：galgame 版面本身不需要全屏，用户还要在另一半屏幕放别的东西——最典型的就是宿主 learn 模式写好的笔记（插件不碰笔记，见第 10 节）。

**窗口与房间的关系**：一个插件实例只维持**一个**窗口，它绑定到最近一次推送的会话（`boundConversationId`）。Room 依旧按 `conversationId` 各存各的帧队列与黑板（§7.1），所以切会话推送时窗口切绑定并发 `restore` 把那个房间的现场还原回来，互不污染。多窗口留给后续需要时再做。

**半屏下的布局**：宽度可能只有 700–960px，所以版式必须**横向可压缩**：

- 页面壳（`.page`）上下留 10px、顶部留 50px 标题栏带，中间是工作区卡片（`.stage`，11.3），教室背景与黑板/立绘/对话框全部相对**这张卡片**定位；
- 教室背景铺满卡片；
- 黑板用百分比定位，占卡片左侧约 78%、上下各留 6%；**板书面布双向可滚动**（8.5），所以窄窗口下内容是滚动而不是被裁掉；
- **讲述槽**（半身）锚右下：`right: 1%` / `bottom: 25%`（底边正好坐在对话框上沿，看起来像被对话框接住）/ `height: 46%`；
- **板书槽**（全身背身）站黑板前偏右：`left: 49%` / `bottom: 30%`（脚底略低于黑板下沿，像站在讲台上）/ `height: 58%`。**偏右是有意的**——板书是左对齐的，站偏右压住的是最右侧，损失最小；
- 两个槽都随窗口宽度等比缩放；窄到 800px 以下时讲述槽向右收窄，板书槽允许被黑板压住一部分；
- 对话框横贯底部（左右各留 4%），高度固定约 22%，内部文本区可滚动；
- 所有尺寸用百分比 + `clamp()`，**禁止写死 px 宽度**，保证窗口本身在任何宽度下不出现横向滚动条（滚动只发生在黑板内容区）。

**上面两个槽的位置数值是实现细节，可以随时调**；但要改就得同步 `assets/约稿要求.md` 的"显示环境"一节——那边写着画师依赖的同一组数字。

**板书立绘必然压住黑板（几何冲突，待确认）**：半屏窗口约 960px 宽，黑板占 `4%..82%`（38–787px），全身立绘显示宽约 388px。她站在黑板前偏右时落在 `470–858px`，**与黑板重叠 317px，即板面宽度的约 42%**。窗口只有 960px 宽，黑板右侧只剩 173px，她不可能"站在黑板旁边而不重叠"。

三个选项：

| 方案 | 做法 | 代价 |
|---|---|---|
| A | 板面常驻右内边距（约 40%），内容只在左侧排版 | `talk` 步时板面右侧留白（内边距**不能**随槽变化，否则她出现/消失时正文会重新折行、滚动位置乱跳） |
| B | 黑板收窄到 62%，立绘站在黑板右外侧 | 黑板明显变小，且立绘需缩到约 49% 高才放得下；她也不再是"在黑板前" |
| **C（当前采用）** | **接受遮挡** | 长行、宽表格的右端会被她挡住（横向滚动仍能看到） |

**当前选 C：接受遮挡。** 理由是这一版的几何参数（黑板 78%、两个槽的 49% / 30% / 58% / 25% / 46%）本来就是**待调的临时值**——先让双槽动画跑通、看到真实观感，再连同黑板尺寸、两个槽的位置与立绘尺寸一起调。那时若仍然碍事，再回到 A 或 B。

**调整这些数值时不必动代码结构，只改 CSS 百分比**，涉及三处：[ui.css](ui.css) 的 `.board`、`.figure-talk`、`.figure-board`。但**必须同步 `assets/约稿要求.md` 的"显示环境"一节**——那边写着画师依赖的同一组数字，不同步会让画出来的图对不上版面。

窗口可拖动、可最大化；用户手动改过尺寸后记进 `prefs`，下次沿用。

窗口自绘标题栏（标题左 / 回放胶囊居中 / 圆形窗口按钮右，形态与宿主主窗口一致，见 11.3），整页可拖动、交互元素 `no-drag`。`unregister()` 里必须 `close()` 所有窗口，`onDispose` 里注销所有 IPC 监听，否则窗口与监听器泄漏。

### 11.2 通道

| 方向 | 通道 | 载荷 |
|---|---|---|
| 主 → 窗口 | `plugin:better-lessons:push` | `{ layer }` |
| 主 → 窗口 | `plugin:better-lessons:restore` | `{ frames, board }`（持久化恢复 / 切换绑定） |
| 主 → 窗口 | `plugin:better-lessons:notice` | `{ kind, text }`（折叠提示、兜底标记） |
| 主 → 窗口 | `plugin:better-lessons:bind` | `{ conversationId }`（窗口绑定到哪个会话） |
| 窗口/面板 → 主 | `plugin:better-lessons:open-window` | 打开课堂窗口（settingsPanel 可用时，它的按钮也走这条） |
| 窗口 → 主 | `plugin:better-lessons:advance` | `{ conversationId }` 推进一帧；结果带 `step` / `transition` / `done` 与最新的 `boardText` |
| 窗口/面板 → 主 | `plugin:better-lessons:lessons` | 列出 `learn/lessons/` 下的剧本（目前只有设置面板用；窗口改用文件选择器，见 14g） |
| 窗口 → 主 | `plugin:better-lessons:pick-lesson` | 弹系统文件选择器挑剧本；单选=重放本节、多选=整节课（14g） |
| 窗口 → 主 | `plugin:better-lessons:replay` | `{ file }` 重放某一节（第 14 节）；结果直接带回 `boardText` |
| 窗口 → 主 | `plugin:better-lessons:replay-all` | 从头重放整节课；结果带回 `files` / `skipped` / `boardText` |
| 窗口 → 主 | `plugin:better-lessons:state` | 查询当前 room 快照 |
| 窗口 → 主 | `plugin:better-lessons:win-*` | `minimize` / `maximize` / `close` |

窗口 → 主走 `ctx.registerIpc(name, handler)`（自动命名空间为 `plugin:better-lessons:<name>`），窗口侧用 `ipcRenderer.invoke`。主 → 窗口走 `pluginWin.webContents.send`，窗口侧用 `ipcRenderer.on`。

用 `ctx.registerIpc` 而不是手工 `ipcMain.on` 的原因：插件停用/刷新时宿主会自动摘除这些处理器，不必自己维护监听表（§11.1 的泄漏防线因此只需要管窗口）。

没有任何笔记相关通道：插件不生产笔记（第 10 节）。



**黑板状态的真相只在主进程**：`advance` 由主进程推进指针并算好新的 `boardText` 一并返回，窗口只渲染、不自持黑板。否则窗口与进程各存一份板，Provider 注入的"当前板书"就可能与用户看到的不一致。

### 11.3 视觉风格对齐宿主主窗口

课堂窗口看起来必须像**同一个应用里的另一扇窗**，所以配色与形态照抄宿主主窗口，而不是自成一派。

**硬约束：抄数值，不引用。** 插件自建窗口拿不到宿主的 CSS 与主题 token（`--rb-*` 只推给 settingsPanel 渲染的页面）。所以把需要的那几组值抄进 [ui.css](ui.css) 的 `:root`，并在这个文件头部注明每组的出处（`react-root.css` / `tokens.css` / `theme.css` / `fonts.css`）——改配色时对着出处抄，别凭印象调。

对照表（左：宿主，右：课堂窗口）：

| 宿主 | 课堂窗口 | 取值 |
|---|---|---|
| `.cy-page` 页面底 + 1px 外框 + 大圆角 | `.page` | `#FAF4F8` / `#F2F2F2` / 24px |
| `.cy-workspace` 工作区卡片 | `.stage` | `#FFFBFC` / 圆角 10px / 内阴影 / 1px `#F2F2F2` |
| 顶部 50px 标题栏带（`padding-top: 50px`） | `.page` 的 `padding-top` | 50px，标题栏就是这条带子，没有独立背景 |
| `.cy-winbtn` 圆形窗口按钮 | `.winbtn` | 30px 正圆 / 1px `#F2F2F2` / hover `#fff1f6` / close hover `#ff5f57` |
| 顶部中间的 `ModeSwitch` 胶囊 | `.pill`（三个回放控件） | 胶囊 token：底 `#fff9fb` / 边 `#ff9fbd` / 字 `#7d3557` |
| 助手消息气泡 | `.dialog-box` | 底 `#f7f7f7` / 边 `rgba(31,35,48,.065)` / 圆角 `4px 16px 16px` / 柔和投影 |
| 行内代码 | `.dialog-text code` | 底 `#f5f5f5` / 字 `#d73a72` |
| 品牌粉 | `--cy-accent` | `#FF5B8A` |
| `--rb-font-sans` / `--rb-font-mono` + Google Fonts | 同序，同样 `@import` | Noto Sans SC / JetBrains Mono，断网落到本地回退栈 |
| `--rb-letter-spacing: 0.7px`（body 继承） | 同 | 0.7px |

**三处有意不跟随宿主：**

1. **黑板板面保留深墨绿**（`linear-gradient(180deg, #182a21, #12211a)` + 粉笔白字）。它是课堂的内容画布，浅色化就读不出"黑板"了。板面上的**强调**从米黄改成 `--chalk-strong: #ffd6e4`——粉笔粉，与宿主强调色同族；行级闪一下的动画底色也跟着换成 `rgba(255,91,138,.3)`。
2. **窗口圆角固定 24px**：宿主允许用户在 0–40 之间调（`--cy-window-radius`），插件读不到那个偏好，只能用它的默认值。用户在宿主里改过圆角就会不一致——这是已知限制，等宿主给插件开一个主题/几何的读取口子再修。
3. **立绘剪影兜底用深色半透明**：浅色底上原来那套白色半透明（`rgba(255,255,255,.24)`）会整个隐身，必须反过来用紫灰（`rgba(76,55,98,.14)`）。

**拖拽区划分**（宿主同款做法）：`.page` 整页 `-webkit-app-region: drag`，交互元素逐个 `no-drag`——**`.stage` 必须显式 `no-drag`**，否则"点击舞台推进一帧"会被拖拽吃掉，表现为点了没反应。

**窗口壳必须透明**：`transparent: true` + `backgroundColor: "#00000000"`（11.1），圆角由 `.page` 自己画。填任何不透明底色都会让圆角外的四个角露出方块。这一条与宿主主窗口（`src/main/windows/create-aux-windows.ts`）完全一致。

## 12. 兜底机制汇总

| 失效点 | 兜底 |
|---|---|
| 模型不调工具 | 6.3 的轮次稽核 + `generateText` 补一段最小剧本 |
| 美术素材缺失或加载失败 | CSS 程序化占位（深绿渐变黑板 + 剪影立绘），版面结构不变（9.1） |
| 剧本某行语法错误 | 跳过该行并告警（4.5） |
| `board <<` 未闭合 | 丢弃该块及其后内容并告警（4.5） |
| `board replace` 的旧内容在板书里找不到 | 忽略该步并告警（4.5） |
| `board replace` 的旧内容命中多处 | 替换第一处并告警（4.5） |
| 窗口未开就收到 push | `execute` 内先 `open()` 再发送（5.3） |
| 旧 run 被 abort 导致半层剧本 | `execute` 首行同步 send（5.3） |
| 帧队列过深 | 从队尾丢弃最旧的未播层并提示（7.3） |
| 窗口崩溃/关闭 | room 保留，下次 push 重开，只播新层 |
| Provider 超时（>2s） | 不做任何 await，纯内存读取，本质不会超时 |

## 13. 持久化

剧本正文**不进 storage**——它在工作区的文件里，那是唯一真相源。storage 只存"怎么摆这些剧本"的状态。

使用 `ctx.storage`（每个 key 一个 JSON 文件，key 需匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`）：

| key | 内容 |
|---|---|
| `rooms` | `{ [conversationId]: { frames, board, lessonFiles, updatedAt } }`；`frames` 里只保留 `{ type, file, cursor, transitionHint }`，**不存 steps 与 boardOps**（只保留最近 3 个会话，每会话最多 3 层） |
| `prefs` | 窗口尺寸/位置、是否自动开窗 |

storage 里**没有任何笔记内容**——插件不碰笔记（第 10 节）。

**恢复流程**：读 `rooms` → 按 `frames[i].file` 逐个读盘并重新解析 → 重建 `steps` 与 `boardOps` → 走 `restore` 通道发给窗口。某个文件读不到时，该帧被丢弃并在窗口提示"第 N 节剧本文件已丢失"。

持久化写入要**去抖**（≥1s），窗口每次点击都写盘会造成明显 IO 抖动。

**这正是"先落盘、再按文件名推送"换来的最大收益**：storage 从"存整份剧本"变成"存一份文件名清单 + 光标位置"，体积小一个数量级，也不可能与磁盘上的剧本内容不一致。

## 14. 课堂回放

剧本既然以文件形式留在 `learn/lessons/`，回放就不需要任何新机制——它只是"按顺序读文件并推送"。

**（a）重放单节** = **清空帧队列与黑板 → 排入这一层**。不是"再推一份同样的剧本"：那样旧的那层还留在队列里，重放完会把用户丢回旧进度，队列也会越堆越深。

- **不插前置过渡帧**。过渡帧的职责是"打断 / 回到被打断的那一层"要有个交代（7.4），而回放是用户自己按的按钮——他已经知道点了什么，再让他点一次"过渡"是多余的一步；窗口在按下按钮时已经立刻清板并弹了提示，视觉反馈由那一步给足。**层与层之间的过渡帧仍然由 advance 在每层结束时补（7.3），分节演出的节奏不变。**
  这条是实测改出来的：原来带前置过渡帧时，用户看到的是"这一节我们再看一遍：《X》"（按钮那一步写的）紧跟"这一节我们再看一遍"（过渡帧写的），被当成"回放播了两次"。
- **播放列表语义**：重放的这一节本来就在 `room.lessonFiles` 里 → 整条列表保留（之后点"从头"仍能放完整节课）；不在列表里（用户从选择器里挑了别的课程的剧本）→ 视为开始新的一节，列表换成它自己。
- 模型也能发起：Provider 已经给出「这节课已用过的剧本文件」清单，模型可以调 `push_script({ file })` 让某一节重演。

**（b）重放整节课** = 同样的清空（同样**不插前置过渡帧**，理由同 (a)），然后按 `room.lessonFiles` 的顺序**全部**排进队列，之后复用现有的 `onClick()` 逐帧推进——播放状态机一行都不用改。

- **队列上限在这一条路径上要放宽**到"播放列表长度 + 1"：`MAX_FRAMES = 9` 本来是防"插话越积越深"的，而回放是用户主动要的一条完整播放列表，被裁掉就少演几节。
- 某一节读不出来（文件被删、被写坏）→ **跳过它继续排**，并在窗口提示跳过了几节，不中断整条链。

**（c）回放的边界**
- 回放的是**文件当前的内容**，不是当初演出的内容。用户手改过剧本，回放就是改后的版本——这是"文件即真相源"的应有之义。
- 某个文件不存在 → 跳过该节并在窗口提示，不中断整条链。
- 回放不进入对话历史、不触发 LLM，是纯本地行为。

**（d）回放不产生任何副产物**：回放是纯播放，不写笔记、不写 `learn/progress.md`、不进入对话历史、不触发 LLM（第 10 节）。所以"从头开始"可以随便点，不会把工作区搅乱。

**（e）顺带打开的两扇门**
- 用户可以直接往 `learn/lessons/` 里丢自己写的 `.bls` 文件：`lesson_list` 能发现，模型能推送，窗口的下拉也能直接选中播放——"手写课程"不需要任何额外开发。
- 将来若要支持"一节课一个文件"，只需给 BLS 加一个层分隔标记，`lessonFiles` 从"文件列表"变成"文件 + 层号列表"，回放逻辑本身不用改。

**（f）控件放哪、入口是什么**

回放控件放在**课堂窗口的标题栏右侧**（`📂 打开剧本`、`⟲ 本节`、`⟲ 从头`）：

- **放标题栏而不是舞台内浮层的硬理由**：舞台的点击处理已经把 `.titlebar` 排除在外，控件放这里天然不会误触发"推进一帧"，不用给点击逻辑打补丁。
- 回放是**课堂内部动作**——用户正看着板书想重放刚才那段，不该让他切到别的窗口去点。
- **不能放进宿主的 learn 界面**：宿主不提供任何界面插槽；learn 模式右下那张「学习」浮动卡是宿主的 `TodoPanel`，内容由 `runSnapshot.todos` 驱动，插件既没有注入通道，也被设计文档明文否定。
- 窗口窄到 760px 以下时把按钮收紧（padding / 字号），把宽度让给标题。

**入口的现实**：纯无 LLM 的入口是**插件列表里的「打开」按钮**——宿主对 `canOpen: typeof plugin.open === "function"` 的插件就会渲染这个按钮，而插件列表放在聊天窗口的插件面板里，不需要进设置页。打开窗口之后，**所有回放都是本地行为**，不再需要模型参与，也不要求会话里有过任何模型回复。

**关于 `settingsPanel`（版本兼容，重要）**：manifest **刻意不声明** `settingsPanel`。这个键是 2026-09-12 的「设置页插件面板扩展点」才加进 manifest schema 的；更早构建的宿主 schema 里没有它，而 schema 是 `additionalProperties: false`，声明了就会**整个插件导入失败**（报 `manifest 结构不合法: must NOT have additional properties`）。`panel.html` 仍然留在包里，等宿主升到支持面板的版本后，在 manifest 里加回一行 `"settingsPanel": "panel.html"` 即可启用。

**（g）用文件选择器挑剧本**

最初窗口里放的是一条"剧本下拉"，从 `learn/lessons/` 列文件。它**实测就直接撞墙**：从插件列表点「打开」进来的窗口没有任何会话绑定，`lessons` 那条 IPC 拿不到工作区根，于是返回 `ok:false`——而下拉只读 `res.files`、把 `reason` 吞掉了，用户看到的是"learn/lessons 下还没有剧本文件"，与事实不符。这个坑有两层教训：

1. **窗口侧的每一条 IPC 都必须把 `reason` 显示出来**，别用兜底文案盖掉真正的错误；
2. 更根本的是：**不该让"看剧本"依赖会话绑定**。用户想自己挑一个剧本看，与"哪个会话绑了哪个工作区"毫无关系。

所以改成系统文件选择器（`dialog.showOpenDialog`，过滤 `.bls`）：

- **单选一个文件** → 当作"这一节"，走 `replayLayer`；**多选** → 按**文件名排序**当作"一整节课"，走 `replayAll`。对话框返回的顺序不保证是点选顺序，所以排序键只能是文件名。
- **默认目录**优先 `<workspace>/learn/lessons/`（插件约定的位置），没有绑定工作区时回落到上次挑过的目录。
- **选中的绝对路径记进 `room.lessonPaths[文件名]`**：这样"本节 / 从头"之后重读这些剧本时，即使它们在工作区外面也读得到。`buildLayerByName` 的读取顺序就是"先查 lessonPaths，再回落到工作区白名单"。
- **路径不走白名单**是刻意的：它来自用户本人在系统对话框里的选择，不是模型给的；而且这条通道只挂在窗口 IPC 上、不是工具，模型碰不到它。模型那条路仍然走 `readLesson` 的白名单校验。
- 没有任何会话绑定时，课堂用 `LOCAL_ROOM_ID = "local"` 作为房间 key，于是"纯本地看剧本"彻底不依赖会话。

## 15. 目录结构

```
examples/better-lessons/
├── DESIGN.md            # 本文档
├── manifest.json        # id: better-lessons, version 0.1.0, entry: index.cjs
├── index.cjs            # register / unregister / open；工具、Provider、事件、IPC
├── prompts.cjs          # 全部给模型的措辞（含各自【调用时机】注释），见 6.1b
├── bls.cjs              # BLS 解析器 + 校验器：文本 → IR + warnings
├── lessons.cjs          # learn/lessons/ 的文件 IO：路径白名单、剧本读写、列举
├── board.cjs            # Board 数据结构与 apply() 纯函数（只在主进程跑）
├── rooms.cjs            # Room 注册表、帧队列操作、持久化
├── panel.html           # 可选设置面板：开关、是否自动开窗、清空课堂。manifest 暂不声明（见 14f）
├── ui.html              # galgame 主窗口（教室背景 / 黑板 / 立绘 / 对话框）
├── ui.css               # 窗口样式（百分比布局；配色抄宿主主窗口，见 11.3）
├── vendor/              # vendored 单文件库，见 3.3
│   ├── markdown-it.min.js
│   ├── markdown-it.LICENSE
│   ├── purify.min.js
│   ├── purify.LICENSE
│   └── LICENSES.md
├── assets/              # 全部美术素材，不依赖宿主（9.1）
│   ├── classroom-bg.jpg
│   ├── board.jpg
│   ├── dialog-bg.png
│   ├── cyrene-talk.png       # 讲述：半身，右下
│   ├── cyrene-write.png      # 板书：全身背身，黑板前
│   ├── cyrene-erase.png      # 擦板：全身背身，主帧
│   ├── cyrene-erase-swing.png # 擦板：挥舞差分（与主帧交替）
│   └── 约稿要求.md            # 交给画师的规格，改素材先改它
└── avatar.png           # 插件图标
```

`assets/` 是**必需项而非可选项**——插件不读宿主任何素材（9.1）。全部素材合计约 3–8 MiB，`vendor/` 约 145 KiB，两者相加远低于 ZIP 导入上限（50 MiB / 2000 条目）。`manifest.json` 的 `deps` 需要 `["llm", "workspace"]`：`llm` 供兜底补剧调用 `generateText`，`workspace` 供非工具场景（`open()`、IPC、回放）取工作区根目录——工具内部则直接用 `ctx.resolvedWorkspaceRoot`，那条路径不需要任何 deps。

## 16. 宿主约束与已知风险

**必须在实现时遵守的宿主事实**

1. 插件主进程与宿主同权限，`require("electron")` 可用；宿主对插件窗口不跟踪、不限制，`close()` 由插件自负。
2. 工具**恒串行**（插件工具缺 `isConcurrencySafe`），且**无 per-tool 超时**。
3. 主聊天路径**不做参数校验**：`JSON.parse` 失败回落 `{}`，`required` 不强制。
4. 工具结果 >30000 字符按 12000 头 + 8000 尾截断；事件 preview 只留 200 字符。
5. `risk: "safe"`（或不写）免审批自动执行。
6. 同会话并发 run 抛 `SESSION_RUN_ACTIVE:<runId>`；渲染端会走"终止旧 run 并重开"，旧 run 被 abort。
7. `modes: ["learn"]` 生效（优先级：用户覆盖 > `modes` > 默认全模式可见）；**chat 模式不暴露任何工具**。
8. 插件自建窗口**拿不到**宿主的主题 token 与偏好（`--rb-*` 只推给 settingsPanel iframe；窗口圆角偏好也没有读取口子），配色字体只能**照抄数值**自备，见 11.3。
9. `host:turn:finished` 的 payload **不含对话文本**，兜底内容必须自己留存。
10. 插件事件监听器是旁路通知，宿主不等待；单个监听器超 5 秒会被记录。

**风险**

| 风险 | 影响 | 缓解 |
|---|---|---|
| 半屏窗口下版面被挤压 | 板书立绘必然压住板面约 42% 宽，长行 / 宽表格的右端被挡 | **当前接受遮挡**（11.1 方案 C）；板面可横向滚动，内容仍看得到；几何参数待统一调整 |
| 模型在板书里注入 HTML/脚本 | 窗口开着 `nodeIntegration`，一次 XSS 即任意代码执行 | **强制** DOMPurify 净化后再插入 DOM（3.3），禁止直接 `innerHTML` |
| 素材体积膨胀 | 插件包变大、首次加载变慢 | 每个素材给体积预算，总量 ≤ 8 MiB（9.1） |
| 模型引用的「旧内容」对不上板书 | 该步被跳过，或改到非预期位置 | Provider 注入板书全文 + 命中多处时告警促使模型写长上下文 |
| 模型不遵守 BLS 格式 | 剧本解析失败率高 | 解析器容错 + 错误信息带回行号让模型自纠 + 格式说明放进 Provider |
| 模型只写文件忘了推送 | 用户看不到任何反应 | 工具描述明写"写完必须紧接着推送" + Provider 硬规则 + 6.3 的轮次稽核兜底 |
| `file` 参数被模型写成路径 | 越界写到工作区外 | 5.3 第 3 条的白名单 + `path.resolve` 前缀比对 |
| 用户手改或删除剧本文件 | 回放内容变化或某节丢失 | 回放按文件当前内容进行（设计如此）；读不到就跳过并提示，不中断整条链 |
| galgame 窗口是纯自绘 UI | 工作量集中在窗口，与宿主能力无关 | 先做"黑板 + 对话框 + 点击推进"最小闭环，立绘后置 |
| 插件窗口不受宿主管辖 | 崩溃可能带崩整个应用 | 窗口侧所有 DOM 操作包 try/catch；错误上报主进程落日志 |

## 17. 分期落地建议

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| P0 | BLS 解析器 + `lessons.cjs` 文件 IO + `write_lesson` / `push_script` + 最小窗口（markdown 黑板 + 点击推进） | 让模型讲一段含 `say <<` / `board <<` / `board replace` / `board clear` 的课，剧本文件落在 `learn/lessons/`，能完整点完 |
| P1 | Provider（格式说明 + 课堂现场 + 板书全文 + 文件清单） + 帧队列（打断/过渡/恢复/瞬时重绘） | 插话后能打断、优先演新层、回到原层从断点续播且黑板正确重绘 |
| P2 | 美术素材（教室 / 黑板 / 对话框 / 讲述·板书·擦板共四张立绘，含擦板挥舞差分） + 立绘"去 → 停 → 回"三拍演出（含擦板差分与讲述跳动） + 半屏自适应布局与黑板双向滚动 + vendored markdown-it 渲染 | 素材全部来自插件 `assets/`；板书 / 擦板每次点击都是"走过去、停一下、走回讲述"的一次性演出，讲述每点一次跳一次，擦板停留期间两帧交替；板书超长时可在黑板内双向滚动，窗口本身不出现横向滚动条 |
| P3 | 回放（`lesson_list` + 窗口的"重放本节 / 从头开始"） + 兜底稽核 + 持久化 + settingsPanel（宿主支持面板后再声明，见 14f） | 关窗重开后能恢复；能在不触发 LLM 的情况下把整节课重演一遍 |
