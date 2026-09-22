/**
 * better-lessons —— learn 模式网课插件（主进程入口）。
 *
 * 骨架状态一览（详细设计见 examples/better-lessons/DESIGN.md）：
 *
 *   已可用  · 半屏 galgame 窗口（§11.1）与 IPC 协议（§11.2）
 *           · learn/lessons/ 的剧本文件读写与路径白名单（§4.6 / §5.3）
 *           · BLS 解析与校验（§4.2 / §4.5）、帧队列与打断恢复（§7.3 / §7.4）
 *           · 窗口侧的帧播放、行级动画与滚动落点（§8.2 / §8.5）、三姿态立绘（§9.2）
 *           · write_lesson / push_script / lesson_list / status / close
 *           · 工具注册与 schema（§5.1 / §5.2）、Provider 注入（§6.2）
 *           · 轮次稽核与兜底补剧（§6.3）、回放三入口（§14）
 *   待办    · 美术素材（§9.1；缺素材时走 CSS 程序化占位，功能不受影响）
 *           · 持久化（§13）
 *
 * 约定：
 *   · 工具 execute 一律返回字符串，不抛异常 —— 主聊天路径不做参数校验（§5.3 第 2 条），
 *     错误要以"模型能读懂并自我修正"的文案回去。
 *   · 注册 IPC 走 ctx.registerIpc，插件停用时宿主自动摘除，不用手工维护监听表。
 */
const path = require("node:path");
const { BrowserWindow, dialog, screen } = require("electron");

const bls = require("./bls.cjs");
const board = require("./board.cjs");
const lessons = require("./lessons.cjs");
const prompts = require("./prompts.cjs");
const rooms = require("./rooms.cjs");

const PLUGIN_ID = "better-lessons";
const CH = (name) => `plugin:${PLUGIN_ID}:${name}`;

// 所有给模型的措辞都在 prompts.cjs（含各自【调用时机】注释）；这里只负责"什么时候送出去"。
const { BLS_FORMAT_SPEC, SAMPLE_SCRIPT, buildClassroomBrief, buildFallbackRequest } = prompts;

/** 每个会话一个 Room 由 rooms 管理；窗口只有一个，绑定到最近一次推送的会话（§11.1）。 */
let pluginWin = null;
let boundConversationId = null;
let ctxRef = null;

/**
 * 从插件列表直接打开窗口、且此前没有任何剧本被推过时，课堂用的房间 key。
 * 有了它，"自己挑一个剧本看"就完全不依赖会话绑定（§14g）。
 */
const LOCAL_ROOM_ID = "local";
/** 跨次选择记住的位置，用于文件选择器的默认目录。 */
const remember = { lastPickedDir: "" };

// ---------------------------------------------------------------- 轮次稽核（§6.3）

/**
 * runId → 本轮课堂相关的动作。
 *
 * 事件是旁路通知（宿主不等待监听器，单个超 5 秒会被记录），所以监听器里只做**同步记账**，
 * 真正的兜底动作留到 turn:finished —— 那时才知道"这一轮结束了、最后还是没人推剧本"。
 */
const runs = new Map();
/** 记账表上限：turn:finished 万一丢了，也不要让它无限增长。 */
const MAX_RUNS = 20;
/** 兜底补剧的冷却：连续几轮都不接课堂时，别每轮都补一段。 */
const FALLBACK_COOLDOWN_MS = 30_000;
const fallbackAt = new Map();

function auditEntry(runId) {
  let entry = runs.get(runId);
  if (!entry) {
    entry = { conversationId: "", mode: "", classroomToolUsed: false, pushed: false, wroteFile: "" };
    runs.set(runId, entry);
    while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
  }
  return entry;
}

function clearAudit() {
  runs.clear();
  fallbackAt.clear();
}

// ---------------------------------------------------------------- 工作区与窗口

/** 工具调用栈里直接拿 ctx.resolvedWorkspaceRoot；其它场景回落到 workspace 绑定。 */
async function workspaceRootOf(toolCtx, conversationId) {
  if (toolCtx && toolCtx.resolvedWorkspaceRoot) return toolCtx.resolvedWorkspaceRoot;
  const binding = await ctxRef?.deps?.workspace?.getBinding(conversationId);
  return binding ? binding.root : null;
}

/** 半屏无边框窗口（§11.1）。已存在则聚焦。 */
async function openWindow() {
  if (pluginWin && !pluginWin.isDestroyed()) {
    pluginWin.focus();
    return pluginWin;
  }

  const { workArea } = screen.getPrimaryDisplay(); // 已排除任务栏
  const win = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: Math.round(workArea.width / 2), // 左半屏
    height: workArea.height,
    minWidth: 640,
    minHeight: 520,
    frame: false,
    resizable: true,
    autoHideMenuBar: true,
    // 与宿主主窗口同一套窗口壳（§11.3）：transparent + 透明底，圆角由页面自己画
    // （src/main/windows/create-aux-windows.ts 也是这么建的）。所以别在这里填不透明底色，
    // 否则圆角外那四个角会露出方块。
    backgroundColor: "#00000000",
    transparent: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  pluginWin = win;
  win.on("closed", () => {
    if (pluginWin === win) pluginWin = null;
  });
  await win.loadFile(path.join(__dirname, "ui.html"));
  return win;
}

function closeWindow() {
  if (pluginWin && !pluginWin.isDestroyed()) pluginWin.close();
  pluginWin = null;
}

/** 主 → 窗口推送。窗口没开就先开（§5.3 第 8 条）。 */
function sendToWindow(channel, payload) {
  if (!pluginWin || pluginWin.isDestroyed()) return false;
  pluginWin.webContents.send(channel, payload);
  return true;
}

/**
 * 把一层交给窗口（§5.3 第 1 条）。模型推送、补推、兜底补剧三条路径共用。
 *
 * 入队之后**同步**发送，中间不要再 await 任何东西 —— 宿主 abort 旧 run 时若卡在 await 上，
 * 就会出现"剧本推了一半"的撕裂状态。窗口没开就先开。
 */
function deliverLayer(room, layer, conversationId, options) {
  const opts = options || {};
  // 窗口只有一个，绑定到最近一次推送的会话（§11.1）。跨会话推送时先让窗口切绑定、
  // 并把那个房间已有的现场还原回去，否则窗口会一边演新房间的步、一边留着上个房间的板书。
  const switching = Boolean(boundConversationId) && boundConversationId !== conversationId;
  boundConversationId = conversationId;

  const deliver = () => {
    sendToWindow(CH("bind"), { conversationId });
    if (switching) {
      sendToWindow(CH("restore"), {
        board: board.boardText(room.board),
        frames: room.frames.length,
      });
    }
    if (opts.dropped > 0) {
      sendToWindow(CH("notice"), {
        kind: "folded",
        text: `课堂内容较多，已折叠 ${opts.dropped} 个较早的层。`,
      });
    }
    if (opts.notice) sendToWindow(CH("notice"), opts.notice);
    sendToWindow(CH("push"), { layer, mode: opts.mode || "interrupt", conversationId });
  };

  if (pluginWin && !pluginWin.isDestroyed()) deliver();
  else openWindow().then(deliver).catch(() => {});
}

/** 文件选择器的默认目录：优先工作区的 learn/lessons/，其次上次挑过的位置（§14g）。 */
async function defaultLessonDir(conversationId) {
  try {
    const root = await workspaceRootOf(null, conversationId);
    if (root && lessons.hasLessonsDir(root)) return lessons.lessonsDir(root);
  } catch (err) {
    // 默认目录只是个便利，拿不到就用上次的位置——绝不能因此让选择器打不开
  }
  return remember.lastPickedDir || undefined;
}

/**
 * 弹系统文件选择器挑剧本。
 * 多选时**按文件名排序**当作一整节课的顺序——对话框返回的顺序不保证是点选顺序。
 *
 * @returns {Promise<{ok:true, files:string[]} | {ok:false, canceled?:boolean, reason?:string}>}
 */
function pickLessonFiles(defaultPath) {
  const options = {
    title: "选择 BLS 剧本（可选多个：按文件名顺序当作一整节课）",
    buttonLabel: "打开",
    filters: [{ name: "BLS 剧本", extensions: ["bls"] }],
    properties: ["openFile", "multiSelections"],
  };
  if (defaultPath) options.defaultPath = defaultPath;

  const owner = pluginWin && !pluginWin.isDestroyed() ? pluginWin : null;
  const pending = owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options);
  return pending.then(
    (result) => {
      if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
      const files = result.filePaths
        .map((item) => path.resolve(item))
        .sort((a, b) => path.basename(a).localeCompare(path.basename(b), "zh-Hans-CN"));
      return { ok: true, files };
    },
    (err) => ({ ok: false, reason: `打不开文件选择器：${err && err.message ? err.message : err}` }),
  );
}

// ---------------------------------------------------------------- 工具

/** 可用剧本文件的兜底文案（§5.3 第 5 条：读盘失败要给可行动的清单）。 */
function availableLessons(root) {
  try {
    const files = lessons.listLessons(root);
    return files.length ? files.join("、") : "（目录为空）";
  } catch (err) {
    return `（列举失败：${err.message}）`;
  }
}

/** 层 id 的递增序号，保证同一个文件被重放多次也不会撞 id。 */
let layerSeq = 0;

/** 解析 + 装层。三条来源（模型推送 / 工作区文件 / 用户挑的文件）共用这一段。 */
function buildLayerFromSource(conversationId, name, source, extras) {
  const opts = extras || {};
  let parsed;
  try {
    parsed = bls.parseBLS(source);
  } catch (err) {
    return { ok: false, reason: `《${name}》解析失败，未推送。${err.message}` };
  }

  layerSeq += 1;
  const layer = rooms.makeLayer({
    id: `lay_${conversationId}_${layerSeq}`,
    runId: opts.runId || "",
    conversationId,
    index: opts.index || 0,
    file: name,
    title: parsed.title || bls.deriveTitle(parsed.steps, ""),
    steps: parsed.steps,
    transitionHint: opts.transitionHint || "",
    fallback: opts.fallback === true,
  });
  return { ok: true, layer, parsed };
}

/**
 * 读盘 → 解析 → 装层。模型推送（push_script）与本地回放（replay / replay-all）共用这一段（§5.3 / §14）。
 *
 * 读取顺序：先查 `room.lessonPaths` 里有没有绝对路径（用户从文件选择器挑过的），
 * 再回落到工作区白名单。这样挑来的剧本即使在工作区外，"本节 / 从头"也还能重放（§14g）。
 *
 * @returns {{ ok: true, layer: object, parsed: object } | { ok: false, reason: string }}
 */
function buildLayerByName(room, root, file, extras) {
  const name = String(file == null ? "" : file).trim();
  if (!name) return { ok: false, reason: `缺少剧本文件名。当前可用：${availableLessons(root)}` };

  const abs = room.lessonPaths ? room.lessonPaths[name] : null;
  let source;
  if (abs) {
    try {
      source = lessons.readLessonByPath(abs);
    } catch (err) {
      return { ok: false, reason: `读取《${name}》失败：${err.message}（原路径 ${abs}）` };
    }
  } else {
    if (!root) {
      return {
        ok: false,
        reason: `《${name}》不是从文件选择器里挑的，而当前会话又没有绑定工作区，读不到它。`,
      };
    }
    try {
      source = lessons.readLesson(root, name);
    } catch (err) {
      return { ok: false, reason: `读取《${name}》失败：${err.message}。当前可用：${availableLessons(root)}` };
    }
  }
  return buildLayerFromSource(room.conversationId, name, source, extras);
}

/** 按绝对路径读盘 → 装层。文件选择器那条路（§14g）。 */
function buildLayerFromPath(room, filePath, extras) {
  const name = path.basename(filePath);
  let source;
  try {
    source = lessons.readLessonByPath(filePath);
  } catch (err) {
    return { ok: false, reason: `读取《${name}》失败：${err.message}` };
  }
  return buildLayerFromSource(room.conversationId, name, source, extras);
}

const writeLessonTool = {
  id: "better-lessons_write_lesson",
  name: "写课堂剧本文件",
  description:
    "把一段讲解写成 BLS 剧本并保存到工作区的 learn/lessons/ 目录。同名文件会被覆盖。" +
    "写完必须紧接着调用 better-lessons_push_script 推送，否则课堂上不会看到任何东西。" +
    "格式见 system context 的《BLS 剧本格式》。",
  enabled: true,
  // 刻意不声明 risk：宿主 obsidian_edit 同为"向 Vault 写文件"却不声明 risk（默认 safe、免审批），
  // 本插件跟随同一做法，避免审批弹窗打断课堂节奏。写入范围被白名单限制在 learn/lessons/（§5.1）。
  effectKind: "mutation",
  modes: ["learn"],
  inputSchema: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description: "剧本文件名，必须以 .bls 结尾、不含路径分隔符。建议「主题-序号-要点.bls」，如 判别式-01-引入.bls。",
      },
      script: {
        type: "string",
        description: "BLS 剧本正文。对白写在 say 块里（一行一句），板书写在 board 块里，改板书用 board replace，清板用 board clear。",
      },
    },
    required: ["file", "script"],
  },
  async execute(args, toolCtx) {
    const file = String((args && args.file) || "").trim();
    const script = String((args && args.script) || "");
    if (!file || !script) {
      return `缺少参数：需要 file（文件名）与 script（BLS 正文）。示例：\n${SAMPLE_SCRIPT}`;
    }
    const root = await workspaceRootOf(toolCtx, toolCtx && toolCtx.conversationId);
    if (!root) return "该会话未绑定工作区，无法写入剧本文件。请确认当前会话处于 learn 模式且已绑定工作区。";
    try {
      const result = lessons.writeLesson(root, file, script);
      // §5.3 第 6 条：写完立刻解析一遍；一个有效 step 都没有就删掉刚写的文件，
      // 避免 learn/lessons/ 里堆积无法演出的残次品，并把问题行号回给模型让它自己修。
      let parsed;
      try {
        parsed = bls.parseBLS(script);
      } catch (err) {
        lessons.deleteLesson(root, file);
        return (
          `剧本写成后校验不通过，已删除 learn/lessons/${result.file}。请修正后重写。\n` +
          `${err.message}`
        );
      }
      const warnNote = parsed.warnings.length
        ? `\n有 ${parsed.warnings.length} 处问题（前 2 条）：\n` +
          parsed.warnings.slice(0, 2).map((w) => `  第 ${w.line} 行：${w.message}`).join("\n")
        : "";
      // 记到本轮账上：模型若只写不推，turn:finished 的稽核会把这个文件补推出去（§6.3a）
      const entry = runs.get((toolCtx && toolCtx.runId) || "");
      if (entry) entry.wroteFile = result.file;
      return (
        `已写入 learn/lessons/${result.file}（${result.bytes} 字节${result.overwritten ? "，已覆盖" : ""}），` +
        `${bls.summarizeSteps(parsed.steps)}。` +
        `接下来必须调用 better-lessons_push_script 推送它。${warnNote}`
      );
    } catch (err) {
      return `写入失败：${err.message}`;
    }
  },
};

const pushScriptTool = {
  id: "better-lessons_push_script",
  name: "推送课堂剧本",
  description:
    "按文件名读取 learn/lessons/ 下的剧本，推送到黑板窗口演出。" +
    "当课堂窗口已开启且用户插话时，必须走「write_lesson 写剧本 + push_script 推送」，不要在聊天框里只回文本。",
  enabled: true,
  risk: "safe",
  effectKind: "mutation",
  modes: ["learn"],
  inputSchema: {
    type: "object",
    properties: {
      file: { type: "string", description: "要演出的剧本文件名，必须已存在于 learn/lessons/。" },
      interrupt: {
        type: "string",
        enum: ["interrupt", "append"],
        description: "interrupt（默认）：打断当前播放并优先演这一层；append：不打断，排到当前播放结束之后。",
      },
      transitionHint: {
        type: "string",
        description: "可选。回到被打断的那一层时显示的过渡文案，如「我们回到刚才那道题」。",
      },
    },
    required: ["file"],
  },
  async execute(args, toolCtx) {
    const file = String((args && args.file) || "").trim();
    const conversationId = (toolCtx && toolCtx.conversationId) || "default";
    const root = await workspaceRootOf(toolCtx, conversationId);
    if (!root) return "该会话未绑定工作区，无法读取剧本文件。请确认当前会话处于 learn 模式且已绑定工作区。";
    if (!file) return `缺少参数 file。当前可用剧本：${availableLessons(root)}`;

    const room = rooms.ensureRoom(conversationId);
    const built = buildLayerByName(room, root, file, {
      runId: (toolCtx && toolCtx.runId) || "",
      index: room.lessonFiles.length,
      transitionHint: typeof args.transitionHint === "string" ? args.transitionHint : "",
    });
    if (!built.ok) return built.reason;
    const { layer, parsed } = built;

    const mode = args.interrupt === "append" ? "append" : "interrupt";
    const { frameCount, dropped } = rooms.pushLayer(room, layer, mode);
    deliverLayer(room, layer, conversationId, { mode, dropped });

    const warnNote = parsed.warnings.length
      ? `\n有 ${parsed.warnings.length} 处问题（前 2 条）：\n` +
        parsed.warnings.slice(0, 2).map((w) => `  第 ${w.line} 行：${w.message}`).join("\n")
      : "";
    const droppedNote = dropped ? `；已折叠 ${dropped} 个较早的层` : "";
    return (
      `已推送《${file}》第 ${layer.index + 1} 层，${bls.summarizeSteps(parsed.steps)}` +
      `（课堂栈深 ${frameCount}${droppedNote}）。${warnNote}`
    );
  },
};

const lessonListTool = {
  id: "better-lessons_lesson_list",
  name: "列出课堂剧本",
  description: "列出工作区 learn/lessons/ 目录下已有的剧本文件，用于回放或接着续写。",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  verificationPolicy: "none",
  modes: ["learn"],
  inputSchema: { type: "object", properties: {} },
  async execute(_args, toolCtx) {
    const root = await workspaceRootOf(toolCtx, toolCtx && toolCtx.conversationId);
    if (!root) return "该会话未绑定工作区。";
    const files = lessons.listLessons(root);
    if (!files.length) return "learn/lessons/ 下还没有剧本文件。";
    return `learn/lessons/ 共 ${files.length} 个剧本：\n${files.join("\n")}`;
  },
};

const statusTool = {
  id: "better-lessons_status",
  name: "查询课堂状态",
  description: "查询课堂窗口是否打开、正在播放哪个剧本第几步、当前板书内容。",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  verificationPolicy: "none",
  modes: ["learn"],
  inputSchema: { type: "object", properties: {} },
  async execute(_args, toolCtx) {
    const conversationId = (toolCtx && toolCtx.conversationId) || "default";
    const room = rooms.getRoom(conversationId);
    const layer = rooms.activeLayer(room);
    const playing = layer
      ? `《${layer.file}》第 ${layer.cursor + 1}/${layer.steps.length} 步`
      : "（无）";
    const text = room ? board.boardText(room.board) : "";
    const boardText = text.length > 2000 ? `${text.slice(0, 2000)}\n…（已截断）` : text || "（黑板为空）";
    return [
      `课堂窗口：${pluginWin && !pluginWin.isDestroyed() ? "已打开" : "未打开"}（绑定会话 ${boundConversationId || "无"}）`,
      `正在播放：${playing}`,
      `板书：\n${boardText}`,
    ].join("\n");
  },
};

const closeTool = {
  id: "better-lessons_close",
  name: "关闭课堂",
  description: "关闭黑板窗口，结束当前课堂。",
  enabled: true,
  risk: "safe",
  effectKind: "mutation",
  modes: ["learn"],
  inputSchema: { type: "object", properties: {} },
  async execute() {
    closeWindow();
    return "课堂窗口已关闭。";
  },
};

// ---------------------------------------------------------------- IPC（窗口 → 主，§11.2）

function registerIpcHandlers(ctx) {
  ctx.registerIpc("open-window", async () => {
    await openWindow();
    return { ok: true };
  });

  ctx.registerIpc("state", () => ({
    windowOpen: Boolean(pluginWin && !pluginWin.isDestroyed()),
    boundConversationId,
    rooms: rooms.allRooms().map((room) => {
      const layer = rooms.activeLayer(room);
      const head = room.frames[0];
      return {
        conversationId: room.conversationId,
        frames: room.frames.length,
        head: head ? head.type : null,
        lessonFiles: room.lessonFiles,
        playing: layer ? { file: layer.file, cursor: layer.cursor, steps: layer.steps.length } : null,
      };
    }),
  }));

  // 用户点击推进一帧（§7.3）。权威状态在主进程：黑板也由这里算好一并返回给窗口渲染。
  ctx.registerIpc("advance", (payload) => {
    const conversationId = (payload && payload.conversationId) || boundConversationId;
    const room = rooms.getRoom(conversationId);
    if (!room) return { ok: false, reason: "当前会话还没有课堂，先让昔涟推送一份剧本吧。" };
    return Object.assign({ ok: true }, rooms.advance(room));
  });

  // 列出可回放的剧本（§14）。窗口的剧本下拉与设置面板都走这条。
  ctx.registerIpc("lessons", async (payload) => {
    const conversationId = (payload && payload.conversationId) || boundConversationId;
    if (!conversationId) return { ok: false, reason: "还没打开过课堂，先让昔涟讲一节吧。" };
    const root = await workspaceRootOf(null, conversationId);
    if (!root) return { ok: false, reason: "该会话未绑定工作区。" };
    return { ok: true, files: lessons.listLessons(root), conversationId };
  });

  // 重放本节（§14a）。纯本地：读盘 → 解析 → 重排队，全程不经过模型。
  ctx.registerIpc("replay", async (payload) => {
    const conversationId = (payload && payload.conversationId) || boundConversationId || LOCAL_ROOM_ID;
    const file = payload && payload.file;
    const root = await workspaceRootOf(null, conversationId);
    const room = rooms.ensureRoom(conversationId);

    // 不预先拦 root 为空的情况：挑来的剧本走 lessonPaths，本来就不需要工作区（§14g）
    const built = buildLayerByName(room, root, file, {});
    if (!built.ok) return { ok: false, reason: built.reason };

    const { frameCount } = rooms.replayLayer(room, built.layer);
    boundConversationId = conversationId;
    sendToWindow(CH("bind"), { conversationId });
    return {
      ok: true,
      mode: "section",
      files: [built.layer.file],
      fallback: built.layer.fallback === true,
      frames: frameCount,
      boardText: board.boardText(room.board),
      warnings: built.parsed.warnings.length,
    };
  });

  // 从头重放整节课（§14b）。播放列表沿用 room.lessonFiles 的顺序，读不出来的那节跳过。
  ctx.registerIpc("replay-all", async (payload) => {
    const conversationId = (payload && payload.conversationId) || boundConversationId || LOCAL_ROOM_ID;
    const root = await workspaceRootOf(null, conversationId);
    const room = rooms.ensureRoom(conversationId);
    const playlist = room.lessonFiles.slice();
    if (!playlist.length) return { ok: false, reason: "这节课还没有可回放的剧本。" };

    const layers = [];
    const skipped = [];
    playlist.forEach((name, index) => {
      const built = buildLayerByName(room, root, name, { index });
      if (built.ok) layers.push(built.layer);
      else skipped.push(name);
    });
    if (!layers.length) {
      return { ok: false, reason: `播放列表里的剧本都读不出来：${skipped.join("、")}` };
    }

    const { frameCount } = rooms.replayAll(room, layers);
    boundConversationId = conversationId;
    sendToWindow(CH("bind"), { conversationId });
    return {
      ok: true,
      mode: "course",
      files: layers.map((item) => item.file),
      skipped,
      fallback: layers[0].fallback === true,
      frames: frameCount,
      boardText: board.boardText(room.board),
    };
  });

  // 用系统文件选择器挑剧本（§14g）。这条路完全绕开会话绑定：
  // 窗口从插件列表直接打开时也照样能用，不需要先让模型推过一次。
  // 路径来自用户本人而不是模型，所以不走白名单；它也不是工具，模型调不到。
  ctx.registerIpc("pick-lesson", async (payload) => {
    const conversationId = (payload && payload.conversationId) || boundConversationId || LOCAL_ROOM_ID;
    const room = rooms.ensureRoom(conversationId);

    const picked = await pickLessonFiles(await defaultLessonDir(conversationId));
    if (!picked.ok) return picked;

    const layers = [];
    const skipped = [];
    picked.files.forEach((filePath, index) => {
      const built = buildLayerFromPath(room, filePath, { index });
      if (built.ok) layers.push(built.layer);
      else skipped.push(`${path.basename(filePath)}：${built.reason}`);
    });
    if (!layers.length) {
      return { ok: false, reason: `选中的剧本都读不出来：\n${skipped.join("\n")}` };
    }

    remember.lastPickedDir = path.dirname(picked.files[0]);
    // 挑来的文件记下绝对路径，"本节 / 从头" 之后靠它重读（即使它不在工作区里）
    picked.files.forEach((filePath) => {
      room.lessonPaths[path.basename(filePath)] = filePath;
    });

    const single = layers.length === 1;
    const { frameCount } = single
      ? rooms.replayLayer(room, layers[0])
      : rooms.replayAll(room, layers);

    boundConversationId = conversationId;
    sendToWindow(CH("bind"), { conversationId });
    return {
      ok: true,
      mode: single ? "section" : "course",
      files: layers.map((item) => item.file),
      skipped,
      fallback: layers[0].fallback === true,
      frames: frameCount,
      boardText: board.boardText(room.board),
    };
  });

  ctx.registerIpc("win-minimize", () => {
    if (pluginWin && !pluginWin.isDestroyed()) pluginWin.minimize();
    return { ok: true };
  });
  ctx.registerIpc("win-maximize", () => {
    if (!pluginWin || pluginWin.isDestroyed()) return { ok: false };
    if (pluginWin.isMaximized()) pluginWin.unmaximize();
    else pluginWin.maximize();
    return { ok: true };
  });
  ctx.registerIpc("win-close", () => {
    closeWindow();
    return { ok: true };
  });
}

// ---------------------------------------------------------------- 兜底稽核（§6.3）

/**
 * 轮次稽核：本轮成功结束、课堂正开着且有内容在播，却没有任何成功的推送。
 *
 * 两种漏法分开处理：
 *   a) 写了剧本文件但忘了推 → 直接把那个文件推出去。不需要模型，结果最确定。
 *   b) 对课堂一个工具都没调过 → 用 Provider 阶段留存的插话原文补一段最小剧本。
 *
 * 若模型调过课堂的其它工具（status / lesson_list / close、或失败的 write_lesson），
 * 说明它是有意识地不动课堂（比如在回答另一个问题），**不补** —— 乱补比不补更烦人。
 */
async function auditTurn(conversationId, entry) {
  if (!conversationId) return;
  const room = rooms.getRoom(conversationId);
  // 课堂没开、或队列空着（还没讲 / 已经讲完）：沉默是正常的，不用补
  if (!room || !room.frames.length) return;
  // 窗口没开、或正显示别的会话的课堂：用户看不到这一间，补了反而会把窗口拽过来
  if (!pluginWin || pluginWin.isDestroyed()) return;
  if (boundConversationId !== conversationId) return;

  const root = await workspaceRootOf(null, conversationId);
  if (!root) return;

  //（a）写了没推：直接补推。这一层是模型自己的内容，不标 fallback。
  if (entry.wroteFile) {
    const built = buildLayerByName(room, root, entry.wroteFile, { index: room.lessonFiles.length });
    if (!built.ok) {
      ctxRef.log(`轮次稽核：模型写了《${entry.wroteFile}》却没推，补推失败：${built.reason}`);
      return;
    }
    const { dropped } = rooms.pushLayer(room, built.layer, "interrupt");
    deliverLayer(room, built.layer, conversationId, {
      mode: "interrupt",
      dropped,
      notice: { kind: "fallback", text: `剧本《${entry.wroteFile}》写了但没推，已替你推出去。` },
    });
    ctxRef.log(`轮次稽核：补推了模型写了却没推的《${entry.wroteFile}》`);
    return;
  }

  if (entry.classroomToolUsed) return; // 有意识地没动课堂
  await fallbackScript(conversationId, room);
}

/**
 * 兜底补剧（§6.3b）：模型这轮对课堂毫无动作，用最小的一次额外调用补一段。
 *
 * 复用与模型完全相同的写盘 + 推送路径，所以它在 `learn/lessons/` 里留得下、回放里也演得出，
 * 与模型产的剧本没有任何区别 —— 不会变成一段只能看一次、无法重演的内容。
 */
async function fallbackScript(conversationId, room) {
  const llm = ctxRef && ctxRef.deps && ctxRef.deps.llm;
  const userText = String(room.lastUserText || "").trim();
  if (!llm || !userText) return;

  const last = fallbackAt.get(conversationId) || 0;
  if (Date.now() - last < FALLBACK_COOLDOWN_MS) return;
  fallbackAt.set(conversationId, Date.now()); // 先记时间，避免并发的第二次调用重复补

  const root = await workspaceRootOf(null, conversationId);
  if (!root) return;

  let text;
  try {
    const request = buildFallbackRequest({ userText });
    text = await llm.generateText(request.messages, request.options);
  } catch (err) {
    ctxRef.log(`兜底补剧：模型调用失败（${err && err.message ? err.message : err}）`);
    return;
  }

  const script = sanitizeGeneratedScript(text);
  const file = `补充-${Date.now()}.bls`; // 名字唯一，且落在 §4.6 的白名单内
  try {
    lessons.writeLesson(root, file, script);
  } catch (err) {
    ctxRef.log(`兜底补剧：写盘失败（${err && err.message ? err.message : err}）`);
    return;
  }

  const built = buildLayerFromSource(conversationId, file, script, {
    fallback: true,
    index: room.lessonFiles.length,
  });
  if (!built.ok) {
    // 与 write_lesson 同一个原则：残次品不留在 learn/lessons/ 里
    lessons.deleteLesson(root, file);
    ctxRef.log(`兜底补剧：生成的内容不是合法剧本，已删除 ${file}。${built.reason}`);
    return;
  }

  const { dropped } = rooms.pushLayer(room, built.layer, "interrupt");
  deliverLayer(room, built.layer, conversationId, {
    mode: "interrupt",
    dropped,
    notice: { kind: "fallback", text: "模型这轮没接上课堂，昔涟临时补了一小段。" },
  });
  ctxRef.log(`兜底补剧：已补《${file}》，${bls.summarizeSteps(built.parsed.steps)}`);
}

/** 模型爱把正文包在代码围栏里、或在前面加一句"好的，这是剧本："。都砍掉再解析。 */
function sanitizeGeneratedScript(text) {
  const lines = String(text == null ? "" : text)
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n");
  const start = lines.findIndex((line) => /^(meta|say|board)\b/.test(line.trim()));
  const picked = start > 0 ? lines.slice(start) : lines.slice();
  while (picked.length && /^```/.test(picked[picked.length - 1].trim())) picked.pop();
  return picked.join("\n").trim();
}

// ---------------------------------------------------------------- 生命周期

function register(ctx) {
  ctxRef = ctx;

  ctx.registerTool(writeLessonTool);
  ctx.registerTool(pushScriptTool);
  ctx.registerTool(lessonListTool);
  ctx.registerTool(statusTool);
  ctx.registerTool(closeTool);

  // §6.2：常驻格式说明；有活跃房间时追加课堂现场（板书全文 + 文件清单 + 强制调工具的硬约束）。
  ctx.registerPromptProvider({
    id: "classroom",
    modes: ["learn"],
    sources: ["conversation"],
    provide({ userText, conversationId, signal }) {
      if (signal && signal.aborted) return "";
      const room = rooms.getRoom(conversationId);
      if (!room) return BLS_FORMAT_SPEC;
      room.lastUserText = String(userText || "");

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

  // §6.3 轮次稽核：模型漏调工具时用 lastUserText 兜底补一段最小剧本。
  // 监听器里只做同步记账，兜底动作留到 turn:finished 异步跑（别占着宿主的发布路径）。
  ctx.events.on("host:turn:started", (payload) => {
    const event = payload || {};
    if (event.source !== "desktop" || !event.runId) return;
    const entry = auditEntry(event.runId);
    entry.conversationId = event.conversationId || "";
    entry.mode = event.mode || "";
  });

  ctx.events.on("host:tool:finished", (payload) => {
    const event = payload || {};
    if (!event.runId || !event.toolId) return;
    if (!String(event.toolId).startsWith(`${PLUGIN_ID}_`)) return;
    const entry = auditEntry(event.runId);
    // 调过课堂的任何一个工具都算"模型知道课堂存在"（失败也算——它试过了）
    entry.classroomToolUsed = true;
    if (event.status === "success" && event.toolId === `${PLUGIN_ID}_push_script`) {
      entry.pushed = true;
    }
  });

  ctx.events.on("host:turn:finished", (payload) => {
    const event = payload || {};
    const entry = event.runId ? runs.get(event.runId) : null;
    if (event.runId) runs.delete(event.runId);
    if (!entry) return; // 没看到这一轮的开头就不猜，免得误补
    if (event.source !== "desktop") return;
    if (event.status !== "success") return; // 取消 / 超时 / 运行错误都不补
    if (event.mode !== "learn" && entry.mode !== "learn") return;
    if (entry.pushed) return;
    auditTurn(entry.conversationId || event.conversationId || "", entry).catch((err) => {
      ctx.log(`轮次稽核兜底失败：${err && err.message ? err.message : err}`);
    });
  });

  ctx.onDispose(() => {
    closeWindow();
    rooms.clearAll();
    clearAudit();
    boundConversationId = null;
    ctxRef = null;
  });

  registerIpcHandlers(ctx);
  ctx.log("better-lessons 已注册：write_lesson / push_script / lesson_list / status / close（含轮次稽核与兜底补剧）");
}

async function open() {
  await openWindow();
}

function unregister() {
  closeWindow();
  rooms.clearAll();
  clearAudit();
  boundConversationId = null;
  ctxRef = null;
}

module.exports = { register, unregister, open };
