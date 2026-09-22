# better-lessons 开发项目记忆

## 工作目录
D:/MyFiles/cyrene/examples/better-lessons

## 部署目录
C:/Users/11/AppData/Roaming/live2d-cyrene/plugins/better-lessons

## 当前阶段（2026-09-18）

**P0 / P1 已完成，P2 除美术素材外完成，P3 完成「回放」与「兜底稽核」两件。** 行为规格一律看同目录 `DESIGN.md`（唯一权威；任何行为变更先改它再改代码）。

| 文件 | 状态 |
|---|---|
| `bls.cjs` | 完成：逐块扫描 + 边扫边 apply 草稿板校验，告警带行号 |
| `board.cjs` | 完成：行数组黑板 + `apply()` / `projectBoardOps()` 纯函数 |
| `lessons.cjs` | 完成：路径白名单 + `learn/lessons/` 读写删列 |
| `rooms.cjs` | 完成：房间注册、帧队列打断/恢复、回放、瞬时重绘、帧数上限 |
| `index.cjs` | 完成：5 工具 + 10 条 IPC + Provider + 轮次稽核与兜底补剧；**持久化仍是 TODO（见下）**。给模型的措辞已全部搬到 `prompts.cjs`，这里只留调用点 |
| `prompts.cjs` | 完成：全部给模型的措辞集中在此（`BLS_FORMAT_SPEC` / `SAMPLE_SCRIPT` / `buildClassroomBrief` / `buildFallbackRequest`），每个上方有`【调用时机】`注释；`BOARD_INJECT_LIMIT = 12000` |
| `ui.html` / `ui.css` | 完成：四层 galgame 壳体 + 播放状态机 + 双向滚动 + 行级动画定位 + **立绘双槽四图与「去 → 停 → 回」三拍演出（§9.2 / §9.3）**；**配色与形态已对齐宿主主窗口的 pearl-white 设计语言（§11.3）** |
| `panel.html` | 壳体完成，但 manifest 刻意不声明 `settingsPanel`（宿主版本兼容，见 DESIGN 14f） |
| `vendor/` | markdown-it 15.0.2 + DOMPurify 3.4.15（上游真实产物 + 许可证正本） |
| `assets/` | **空**（只有 `.gitkeep`）；按 §9.1 需要 7 个文件（4 张立绘含擦板挥舞差分），规格见 `assets/约稿要求.md` |

- 工具：`write_lesson` / `push_script` / `lesson_list` / `status` / `close`
- IPC：`open-window` / `state` / `advance` / `lessons` / `replay` / `replay-all` / `pick-lesson` / `win-minimize` / `win-maximize` / `win-close`
- manifest 的 `deps`：`["llm", "workspace"]`；**不含 `settingsPanel`**（见"关键坑 1"）

## 已实测通过

1. 打开窗口 → `📂 打开剧本` → 点击逐帧推进
2. 长对白（493 字）→ 对话框内滚
3. 40 行封面板书 → 黑板纵向滚到**新增内容底部**
4. 宽表格 / 长代码行 → 横向滚
5. 强调某行 → 贴视野**顶部**，且只闪那一行
6. 清板
7. 多选两节 → 整节课连播，层间过渡帧只出现一次
8. `⟲ 本节` / `⟲ 从头` / `📂 打开剧本` 三个控件
9. 播放中改剧本文件后重放能读到新版本（此前"播放旧版本"是编辑未落盘）
10. 兜底稽核（打桩验证，33 项断言）：正常推送不补、写了没推直接补推、毫无动作则补剧、冷却生效、非成功终态/非 learn/空课堂/窗口未开都不补、生成内容不合法则删文件不推
11. 立绘三拍演出（抽真实 `playFigure` / `stageOf` / `setSwing` 喂假定时器，60 项断言）：say 只跳一次且不排回程、板书"去→停 900ms→回"、擦板停留期间每 380ms 交替且 1140ms 后回、**演出中点击立刻打断并重排**、瞬时重绘不演且清掉在途定时器、差分缺失退化为静态主帧但时长不变、按槽独立降级剪影
12. 跳动触发规则（抽真实 `applyFrame` 接线到桩 UI，36 项断言）：**课后连点 4 次一次都不跳**（回归）、say 每点一次跳一次、板书/擦板/过渡帧/未知 step 都不跳、`bounce:false` 显式关掉、三拍演出未被破坏
13. 提示词拆分到 `prompts.cjs`（9 项断言）：导出齐全；`SAMPLE_SCRIPT` 能被 `parseBLS` 解析且**无 warning**；四类 room 形态下 Provider 注入文本与拆分前**逐字节一致**；超长板书只保留末尾 12000 字符；兜底请求形状（2 条消息 + `maxTokens 512` + `purpose`）；`index.cjs` 里已无任何提示词正文
14. 黑板上的"空"三种语义（抽真实 `ui.html` 整段脚本跑桩 DOM + 桩 IPC，14 项断言）：开场态显示「等待剧本推送…」+「打开剧本」引导；推送后未点击 → 黑板全空 + 「昔涟推送了一节课给你」；过渡帧 / `say` / `board clear` 后黑板空得干干净净；播放中插话推送不顶掉当前对白；重开窗口**只在队列里还有帧**时才不显示空板提示（回放播完再重开 = 开场态，回归）；开场态点一下不宣布「这节课到这里」；真上过课的 `done` 照常收课（回归）
15. 视觉风格对齐宿主（12 项断言，含 4 项行为回归）：内联脚本语法通过、脚本引用的 19 个 id 全在 HTML 里、关键类名都有样式；宿主的 11 个色值 + 窗口 24 / 卡片 10 两个圆角逐个对齐；黑板仍是深墨绿；窗口壳透明、`.page` 可拖 `.stage` 可点；改版后开场态 / done / 推送 / 清板四条行为不变。**观感另用两个临时静态预览页在浏览器里截图核过**（有板书态 + 开场态）

## 尚未真实测试（重要）

**模型那一路至今只在桩上验过，没跑过真实对话**：Provider 提示词（含 BLS 格式说明 + 课堂现场 + 板书全文）→ `write_lesson` → `push_script` → 插话打断。具体未测：

- 模型是否真会按 BLS 格式输出，格式说明是否够用
- 播放中插话 → 打断压栈 → 新层播完弹栈 → 清板 + 瞬时重绘恢复断点（帧队列这段在单元层验过，但没跑过真实事件）
- 兜底稽核在**真实宿主事件**下的表现：事件字段与时序只在打桩时验过（33 项断言全过），宿主实际发出来的 payload 还得看一次

## 接下来的步骤

**A. 美术素材（DESIGN 9.1）** — 7 个文件（教室 / 黑板 / 对话框 + 4 张立绘），规格与显示环境数值都在 `assets/约稿要求.md`。丢进去即生效，不用改代码（立绘按高度等比缩放，尺寸对不上只会观感不对，不会报错）。

**B. 持久化（DESIGN 13）** — `ctx.storage` 存 `rooms`（只存文件名 + cursor，不存 steps/boardOps）与 `prefs`；写入去抖 ≥1s；关窗重开后 `restore` 恢复现场。顺带：窗口尺寸/位置目前每次都用默认左半屏，没记进 `prefs`。

**C. 几何参数统一调整（DESIGN 11.1）** — 当前按**方案 C 接受遮挡**：板书立绘压住板面约 42% 宽，长行/宽表格右端被挡（横向滚动仍能看到）。等素材到位、看到真实观感后，一起调黑板尺寸、两个槽的位置与立绘尺寸。**只改 CSS 百分比，不动代码结构**，涉及 [ui.css](ui.css) 的 `.board` / `.figure-talk` / `.figure-board` 三处，改完必须同步 `assets/约稿要求.md` 的"显示环境"一节。

**D. 已知限制：表格内某列的横向定位** — 行区间标注只到元素一级，没下沉到行内元素（`<td>` / `<code>` 内部），所以强调宽表格里的某一列时纵向会把那一行带到顶部、但**不会横向滚到那一列**。要修得再往下沉一层。

**E. settingsPanel** — 等宿主升到支持它的构建后，manifest 加回一行 `"settingsPanel": "panel.html"`。

**F. 模型那一路的联调** — 需要在一个绑定 `D:\MyFiles\Cpplearn` 的 learn 会话里实测，重点看格式说明够不够模型用、以及插话打断的手感。

## 关键坑（已踩，别再踩）

1. **manifest 不能声明 `settingsPanel`**：旧宿主 schema 是 `additionalProperties: false`，多一个键整个包导入失败（报 `must NOT have additional properties`）。
2. **滚动定位不能用 `scrollIntoView("nearest")`**：比视野还高的元素（40 项列表只有一根 `<ul>`）顶边本来就可见，`nearest` 永不触发，用户以为没反应。要直接量矩形补 `scrollTop`。
3. **行区间必须下沉到 `<li>` / `<tr>`**，只标块级会让"滚到新增底部""强调贴顶"双双失准。
4. **代码围栏带语言时属性会被丢**：markdown-it 的 `fence` 规则为带语言的围栏另造假 token 渲染 `<code>`，挂真 token 上的属性被丢弃 → 改成注入 `<pre>`。
5. **`ALLOW_DATA_ATTR: true` 是必须的**，否则 `data-line` 会被 DOMPurify 静默剥掉（不报错）。
6. **回放不插前置过渡帧**：否则"按钮写的文案"与"过渡帧文案"重复，被当成播了两次。
7. **窗口侧每条 IPC 都要显示 `reason`**：曾经用兜底文案盖掉真错误，显示成"还没有剧本文件"，与事实不符。
8. **`host:tool:finished` 不带参数**：想知道模型写的是哪个剧本文件，只能靠插件自己的工具在 `execute` 里往本轮（按 `runId`）账上记 —— 事件里看不出来。
9. **兜底不能按"任何没成功推送的 learn 轮次都补"**：那会让用户每问一个与课堂无关的问题都收到一段凭空生成的剧本。判据是"模型这一轮调过课堂的任何工具就不补"，乱补比不补更烦人。
10. **兜底生成的内容要清洗再落盘**：模型爱包代码围栏、或在前面加一句「好的，这是剧本：」。
11. **队列排空后 `advance` 会持续返回 `done`**：课后每点一次回来的还是 `done`，所以 `done` 分支里任何"有反应"的代码（跳动、切姿态）都会变成"课后每点一次弹一下"。跳动只由真正的 `say` step 触发（`bounce: step.kind === "say"`），`done` / 未知类型 / 瞬时复位都显式关掉。
12. **给模型的示例文本必须逐字合法**：`SAMPLE_SCRIPT` 是让模型"照抄"的，里头的 `board replace Δ > 0 -> **Δ > 0**` 曾指向自己板书里根本不存在的内容（板书只写了 `Δ = b² − 4ac`），模型照抄就学到一种必然 miss 的写法。凡改动 `prompts.cjs` 里的示例，都要先喂一遍 `parseBLS` 断言 `warnings.length === 0`。
13. **改提示词只改 `prompts.cjs`**：BLS 语法一变，`BLS_FORMAT_SPEC`（每轮注入）与 `SAMPLE_SCRIPT`（工具报错里给模型抄）必须同时改，摆在一个文件里才不会只改一半。`index.cjs` 里不该再出现任何提示词正文。
14. **黑板为空 ≠ 在等推送**：空板提示（`#boardEmpty`）只在"窗口刚打开、什么都没收到"时该出现；清板后、以及推送后第一帧还没铺开时，都必须是干干净净的空。靠一个只向一个方向翻转的 `idleEmpty` 标志管住（§8.6），**`done` 不翻转**，否则"没内容时点一下"就会莫名退出开场态。
15. **"这个房间讲过课"不能当成"还有内容"**：重开窗口判断开不开场态，只能看 `room.frames > 0`（还有没播完的），**不能看 `lessonFiles` / `playing`**。回放播完再关窗重开，`lessonFiles` 还留着但队列早空了，判错就会说出一句"昔涟推送了一节课给你"，而昔涟什么都没推（实测踩过）。
16. **脚本顶层的裸 `id` 引用**：`ui.html` 里 `stage.addEventListener(...)` 靠浏览器"带 id 的元素会成为 window 属性"这条规则活着（同文件里其余元素都规规矩矩走 `getElementById`）。改 DOM 时别顺手把 `id="stage"` 去掉，也别在桩环境里漏掉这个全局。
17. **窗口配色只能"抄数值"**：插件拿不到宿主的 CSS / 主题 token / 圆角偏好，ui.css 的 `:root` 里是宿主 `--cy-*` / `--rb-*` 的**副本**，文件头写着每条抄自哪个文件（§11.3）。改配色对着那些文件抄，别凭印象调；宿主的主题只有 pearl-white 一种（`src/shared/ui-theme.ts` 的 `normalizeUiTheme` 无条件返回它）。
18. **透明窗口 + `no-drag` 两件套**：`.stage` 必须显式 `-webkit-app-region: no-drag`，否则整页的拖拽区会把"点击舞台推进一帧"吃掉，表现为点了没反应；窗口必须 `transparent: true` + `backgroundColor: "#00000000"`，否则 `.page` 的 24px 圆角外会露出方块。

## 迭代与部署方式

仓库改 → 同步到部署目录 → 插件面板刷新（或停用/启用重新加载模块）。玩法：

- 部署：`Copy-Item` 逐文件 + `Get-FileHash` 比对（要 0 处不一致才收工）
- ZIP：`Compress-Archive`，文件在包根、`vendor/` 与 `assets/` 作目录（仅在需要给别人用时才打）
- 冒烟测试：临时脚本放 `.tmp-check/` 跑完即删；既有做法是"抽出 ui.html 里的真实函数喂桩 DOM"，25–56 项断言

## 测试剧本（工作区）

- `D:\MyFiles\Cpplearn\learn\lessons\Cpp入门-01-第一个程序.bls` — 11 步，覆盖 `say` / `boardBlock` / `board replace` / `board clear`
- `D:\MyFiles\Cpplearn\learn\lessons\压力测试-01-长对白与长板书.bls` — 10 步，覆盖长对白 / 长板书 / 宽表格 / 长代码行 / 长板强调
