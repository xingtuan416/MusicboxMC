# 项目状态

> 每次有实质进展就更新这个文件。**写法见 `AGENTS.md` 的「状态文档」一节。**
> 最后更新：2026-10-18

## 一句话

0.2.1 已发布；工作区有一批未提交的界面、文档、注释与质量闸门修复，等用户测试后提交。

## 位置

| 项       | 值                                                                                           |
| -------- | -------------------------------------------------------------------------------------------- |
| 版本     | `0.2.1`（`package.json`、tag、Release 一致）                                                 |
| 分支     | `main`，与远端同步                                                                           |
| 最新发布 | `v0.2.1`：安装包 79.7 MB、免安装 109.3 MB、资源包 51 KB                                      |
| 备份     | 分支 `backup/before-ui-integration`、标签 `backup-before-ui-integration`、`v0.1.0` —— 不要删 |

## 质量闸门（最近一次实测，2026-10-18）

| 项                     | 结果                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `npm test`             | 27 文件 / 212 用例通过                                        |
| `npm run lint`         | 无输出（`scripts/**/*.cjs` 已按 CommonJS 配置）               |
| `npm run typecheck`    | 无输出                                                        |
| `npm run build`        | 通过                                                          |
| `npm run smoke`        | 10 项通过（真 IPC、真写盘、真窗口，bridge 暴露 11 个方法）    |
| `npm run verify:ui`    | 通过，无 console 错误、无横向溢出                             |
| `npm run verify:about` | 通过（版本 0.2.1、许可 GPL-3.0、标题栏图标 1063×1063 已解码） |
| CI                     | 绿：run #31（`11b3280`），Node 20 / 22 各 11/11 步通过        |

## 已完成（按时间倒序，只留结论）

- **注释统一**：`index.html` 的 33 条 CSS/HTML 注释与 `scripts/fresh-dist.cjs` 的 JSDoc 全部改为英文；顺手修正 CSS 里过时的步骤编号（生成进度是第 7 步、问题清单是第 6 步）和 `265px`→`240px` 的高度下限。代码注释现在只有 `textEncoding.ts` 的乱码示例保留中文（`AGENTS.md` 的既定例外）。
- **`index.html` 标签核对**：源文件 `<div>` 与 `</div>` 各 142 个，标签栈无未闭合/多余项，lxml 解析与 Chromium DOM 也都是 142 个——原「多一个 `</div>`」的记录不成立，已从已知问题删除。
- **质量闸门修复**：`npm run lint` 从 109 个错误恢复到无输出。原因是 eslint 只给 `**/*.ts` 和 `scripts/**/*.mjs` 配了 Node globals，收进仓库的 `*.cjs` 验证脚本全部报 `no-undef` / `no-require-imports`；现在 `scripts/**/*.cjs` 按 CommonJS 配置并同时声明 Node 与浏览器 globals（`verify-ui` / `verify-about` 会把函数交给 `page.evaluate` 在页面里跑），另删掉 smoke 里未使用的 `pack`。
- **文档对齐**：README / README.en 删除并不存在的缩放按钮、把「需要注意」改为「检查结果」、下载文件名 `0.1.0`→`0.2.1`、资源包按钮位置改到导出步骤；`architecture.md` / `command-playback.md` 更正渲染层入口（`app.js`）与命令后端路径（`core/command/index.ts`）；CONTRIBUTING 修好被代码块吞掉的「Checking the interface」标题，以及 `warnings.js`→`warningText.js`。
- **死代码清理**：删掉无人调用的 `zoomPreview` / `fitPreview` / `ZOOM_STEP` / `previewRenderScale`、`state.checkResult`、`dom.js` 的 `fmtBytes` / `kv` / `table` / `card`、preload 与主进程的 `chooseOutput` 通道、`#packRequired` 死元素（其文案还与「资源包可选」矛盾）和三个未使用的 id；补 `<link rel="icon">` 后 `verify:ui` 不再报 favicon 404。
- **0.2.1**：换新图标（米色底，窗口/任务栏/安装包/标题栏统一）；关于页许可行改为「开源许可证」。
- **审查修复**：NBT 报错位置改为文件内绝对偏移；超大字符串编码前拒绝；删除不可达的默认 tempo 兜底；「时间无效」文案补齐。
- **litematic 测试独立化**：以 `test/fixtures/VerifyLitematic.java`（按规范独立实现）为权威，断言结构与每个格子的方块。
- **端到端冒烟**：`npm run smoke` 走真 preload + 真 IPC，核到「磁盘上的文件字节数 === 返回值」。
- **界面**：八步流程、红石布线预览、检查结果分组分页、资源包入口、无边框窗口、音效。
- **核心修复**：Modified UTF-8、SMPTE 不再死循环、首个 tempo 偏晚、补齐不再饿死分支、最小八度位移、±75ms 量化界、`app://` 目录边界。

### 工作区未提交的改动（等用户测试）

| 文件                                                            | 内容                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `README.md` / `README.en.md`                                    | 版本兼容说明；本次的流程、页面名、下载名与资源包位置对齐                         |
| `src/renderer/app.js`                                           | 检查结果每页 4 条；拖动 rAF 节流；滚动提示；删死状态                             |
| `src/renderer/index.html`                                       | 音域两项改名；滚动条与滚动提示；删死元素；补 favicon；注释英文化                 |
| `test/midiTextEncoding.test.ts`                                 | 注释英文化（GBK 样例字节与断言不变）                                             |
| `src/renderer/preview.js` / `state.js` / `dom.js` / `blocks.js` | 删掉无人调用的缩放/适配与死导出                                                  |
| `src/main/index.ts` / `src/preload/index.ts`                    | `shell:open` 走 `openExternal`；删掉无人调用的 `chooseOutput`                    |
| `scripts/`                                                      | 验证脚本收进仓库；eslint 的 CommonJS 配置；注释英文化；verify:about 自建截图目录 |
| `package.json` / `.github/workflows/ci.yml`                     | 加 `verify:ui` / `verify:about`；CI 加 `lint` 步骤                               |
| `AGENTS.md` / `docs/status.md`                                  | 给代理读的上下文文件；本文件                                                     |

## 已知问题（诚实清单）

1. **画布拖动仍不跟手** —— 用户实测反馈。已改 rAF 节流并累积增量，但手感仍未达标；可能需要在 `preview.js` 里改成「只重绘可见区域」或复用离屏画布。
2. **多乐器未支持** —— MIDI 的乐器信息目前被忽略，全部按音高映射到固定音色表；鼓、电子琴等尚未接入，且「全竖琴音域下音色被占掉要报严重错误」未实现。
3. **`docs/` 的散文断言只核了数字** —— 10 个可机核数字全部一致，段落里的因果论断未逐条验证。
4. **CI 不跑 `verify:ui` / `verify:about` / `smoke`** —— 它们需要显示环境与真实 Electron，目前只能本地跑。
5. **本机 `ELECTRON_RUN_AS_NODE=1` 是设着的** —— 跑 `_electron` / Electron 前必须删掉，否则 `require('electron')` 返回字符串。
6. **`out/` 是本地目录，不入库** —— 中间文件一律放这里，不要放 `/tmp`（Git Bash 与原生 node 解析不同）。

## 待用户决定

1. 多乐器支持是否单开一轮？
2. 拖动不跟手的可接受程度（要不要现在深挖）。
3. 这批未提交改动是否提交；若提交，按 `fix:`（lint 闸门）/ `docs:`（文档对齐）/ `refactor:`（死代码与注释）拆成几个 commit？
