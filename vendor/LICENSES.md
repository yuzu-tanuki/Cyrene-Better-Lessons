# Vendored 依赖清单

本目录下的第三方库是**手工 vendor 的单文件构建**。插件窗口没有打包器，用 `<script src="vendor/…">` 直接加载；
升级时手工替换文件并同步更新本表——没有 lockfile 可依赖（DESIGN.md §3.3）。

| 文件 | 上游包 | 版本 | 许可证 | 许可证副本 |
|---|---|---|---|---|
| `markdown-it.min.js` | `markdown-it` | 15.0.2 | MIT | `markdown-it.LICENSE` |
| `purify.min.js` | `dompurify` | 3.4.15 | Apache-2.0 或 MPL-2.0（双许可，本项目按 Apache-2.0 使用） | `purify.LICENSE` |

## 取法

```powershell
npm pack markdown-it dompurify
tar -xzf markdown-it-15.0.2.tgz   # → package/dist/browser/markdown-it.umd.min.js
tar -xzf dompurify-3.4.15.tgz     # → package/dist/purify.min.js
```

## 说明

- `markdown-it` 的浏览器 UMD 构建在 `dist/browser/` 下，不在 `dist/`；本目录存为 `markdown-it.min.js`。
- 两者都是单文件、无运行时依赖，符合"无打包器环境"的约束。
- 全局名：`window.markdownit`、`window.DOMPurify`。
- **不引入任何 markdown 语法扩展插件**：强调一律用标准 `**加粗**`（DESIGN.md §8.2）。
- `purify.min.js` 是**必需项**：插件窗口开着 `nodeIntegration`，板书正文又来自模型，
  一次未消毒的 HTML 注入等于任意代码执行（DESIGN.md §16）。
