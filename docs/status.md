# 项目状态

> 每次有实质进展就更新这个文件。**写法见 `AGENTS.md` 的「状态文档」一节。**
> 最后更新：2026-10-19

## 一句话

0.2.3 已发布：修复第 2 步拖拽、收口 0.2.2 代码审查发现，并统一本地/CI 检查流程。

## 位置

| 项       | 值                                                                                           |
| -------- | -------------------------------------------------------------------------------------------- |
| 版本     | `0.2.3`（`package.json`、tag、Release 一致）                                                 |
| 分支     | `main`，与远端同步                                                                           |
| 最新发布 | `v0.2.3`：安装包 79.7 MB、免安装 109.3 MB、资源包 51 KB                                      |
| 备份     | 分支 `backup/before-ui-integration`、标签 `backup-before-ui-integration`、`v0.1.0` —— 不要删 |

## 质量闸门（最近一次实测，2026-10-19）

| 项                     | 结果                                                              |
| ---------------------- | ----------------------------------------------------------------- |
| `npm test`             | 35 文件 / 276 用例通过                                            |
| `npm run lint`         | 无输出（`scripts/**/*.cjs` 已按 CommonJS 配置）                   |
| `npm run typecheck`    | 无输出                                                            |
| `npm run build`        | 通过                                                              |
| `npm run smoke`        | 10 项通过（16 轨夹具走真 IPC：346 音、16 轨、约 2.6 KB 写盘一致） |
| `npm run verify:ui`    | 通过，无 console 错误、无横向溢出；覆盖模式切换与分配表           |
| `npm run verify:about` | 通过（版本 0.2.3、许可 GPL-3.0、标题栏图标 1063×1063 已解码）     |
| `npm run format:check` | 通过                                                              |
| CI                     | 绿：run #39（`24c3945`），Node 20 / 22 各 11/11 步通过            |

## 已完成（按时间倒序，只留结论）

- **0.2.3 后续审查修复**：Kimi K3 全量审查后修复 6 条（README 版本钉死、八度警告混淆 transpose、CONTRIBUTING 浏览器说明、`GenerateOptions` IPC 校验、`shell:open` 本地路径限制、外链前缀边界），拖拽高亮和点击导入测试也补上；剩余 3 条低优先级建议见已知问题。CI run #39 绿。
- **0.2.3 发布**：第 2 步拖拽恢复（Electron 32 移除 `File.path`，改走 preload `pathForFile` + 整步 drop target）；修复 0.2.2 审查发现（外链白名单、排除轨不再进入警告/分配表/`pitchRange`、八度拟合计入 transpose、去掉大轨 `Math.max(...)` 展开）；新增 `npm run check` 作为本地/CI 单一闸门；GitHub About 改中文并整理 19 个 topics。资产已上传 [GitHub Releases](https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.3)。
- **0.2.2 发布**：多乐器支持、紧凑和弦行、多轨间距与强制合并修复；安装包/免安装/资源包已上传 [GitHub Releases](https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.2)，tag `v0.2.2`。
- **配置摘要联动**：第 4 步「其它」折叠下的小字现在随合并模式、作者、基准 TPS 更新；之前一直停在初始文案。`verify:ui` 增加了对应检查。
- **和弦行相邻**：强制合并的紧凑路径改成普通和弦列——≤3 音只给内联音一个中继器、两侧靠单跳；≥4 音每行一个同延迟中继器，音符行**相邻不留空**；超过 27 音的极端和弦才退回 staged 两行总线。新增 `test/chordSpacing.test.ts`（3/4/20 音）。
- **间距与强制合并修复**：普通模式的 Z 间距改为按每条轨自己的和弦上下行数计算，相邻轨之间固定留一格空行（16 轨夹具从每轨间 5–6 格缩到 1 格）；「强制合并」改为全曲合成一条主线（之前是每种乐器一条，16 轨仍有 12 条），每个音仍按自己源轨的乐器/八度映射，`forcedValidation` 校验整条主线；预览初始定位到音符最多的主行，不再开在空白上支。
- **多乐器支持（0.2.2）**：16 种经典音符盒乐器（13 有音高 + 3 固定鼓）；识别顺序 GM 音色 → 通道 9 鼓 → 轨道名 → 竖琴；两种模式——「原版乐器」与默认的「扩展竖琴音域」（五槽钢琴保留，其余乐器原版，被占用的 bass/guitar/flute/bell 用 didgeridoo/banjo/bit/chime 替代）；整轨先选八度、个别音再兜底；红石与命令后端、界面、预览颜色、警告文案、文档全部接入。16 轨夹具 `test/fixtures/happy-birthday-16.mid` 入库，新增 58 个测试。
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

### 0.2.3 发布资产

- `release/MusicboxMC-Setup-0.2.3-win-x64.exe`（79.7 MB）
- `release/MusicboxMC-0.2.3-win-x64.zip`（109.3 MB）
- `release/MusicboxMC-piano-pack-1.20.4.zip`（51 KB）
- GitHub Release：[v0.2.3](https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.3)，tag 与 `package.json` 版本一致；三个资产均为 `uploaded`。

## 已知问题（诚实清单）

1. **画布拖动仍不跟手** —— 用户实测反馈。已改 rAF 节流并累积增量，但手感仍未达标；可能需要在 `preview.js` 里改成「只重绘可见区域」或复用离屏画布。
2. **`docs/` 的散文断言只核了数字** —— 10 个可机核数字全部一致，段落里的因果论断未逐条验证。
3. **CI 不跑 `verify:ui` / `verify:about` / `smoke`** —— 它们需要显示环境与真实 Electron，目前只能本地跑。
4. **本机 `ELECTRON_RUN_AS_NODE=1` 是设着的** —— 跑 `_electron` / Electron 前必须删掉，否则 `require('electron')` 返回字符串。
5. **`out/` 是本地目录，不入库** —— 中间文件一律放这里，不要放 `/tmp`（Git Bash 与原生 node 解析不同）。
6. **OpenCodeReview 仍只完成了一部分** —— 0.2.3 小范围 15 个文件里 6 个分组失败，产出 3 条发现（外链前缀边界、拖拽高亮落在隐藏元素、点击导入无测试），已全部修复。随后用 Kimi K3 跑全量 `v0.2.1..HEAD`：49 个文件、9 条发现，但 37/49 个分组仍因本地网关 503 失败。已修 6 条（README 版本钉死、八度警告混淆 transpose、CONTRIBUTING 浏览器说明、`GenerateOptions` 未校验、`shell:open` 本地路径过宽），剩余 3 条低优先级建议保留（`NOTE_BLOCK_INSTRUMENTS` 依赖对象键序、`summarizeAssignments` 重复拟合、span 与 outside 的统计帧）。这些是 0.2.3 发布后的修复，尚未进入 0.2.3 的安装包；是否发 0.2.4 待定。

## 待用户决定

1. 拖动不跟手的可接受程度（要不要现在深挖）。
