# 项目状态

> 每次有实质进展就更新这个文件。**写法见 `AGENTS.md` 的「状态文档」一节。**
> 最后更新：2026-11-14

## 一句话

`0.3.0` 已完成修复、工具链升级和用户实测；**未提交、未打 tag、未发布**，等待发布决定。

## 位置

| 项       | 值                                                                                           |
| -------- | -------------------------------------------------------------------------------------------- |
| 版本     | `0.3.0`（仅 `package.json`；tag 与 Release 仍是 `v0.2.5`）                                   |
| 分支     | `main`；工作区有未提交的 `0.3.0` 改动                                                        |
| 最新发布 | `v0.2.5`：安装包 79.7 MB、免安装 109.3 MB、资源包 51 KB                                      |
| 备份     | 分支 `backup/before-ui-integration`、标签 `backup-before-ui-integration`、`v0.1.0` —— 不要删 |

## 质量闸门（最近一次实测，2026-11-14）

| 项                         | 结果                                                      |
| -------------------------- | --------------------------------------------------------- |
| `npm test`                 | 38 文件 / 286 用例通过                                    |
| `npm run lint`             | 无输出                                                    |
| `npm run typecheck`        | 无输出（tsc 7.0.2；ESLint 使用并排 TS 6 API）             |
| `npm run build`            | 通过（Node 24）                                           |
| `npm run smoke`            | 12 项通过（Electron 45；目录授权与越界拒绝已覆盖）        |
| `npm run verify:ui`        | 通过，无 console 错误、无横向溢出                         |
| `npm run verify:about`     | 通过（版本 0.3.0、许可 GPL-3.0-only、标题栏图标已解码）   |
| `npm run verify:litematic` | 通过（独立 Java 读取器接受当前写入器）                    |
| `npm run format:check`     | 通过                                                      |
| Node 24 完整打包           | 通过，安装包与便携版在 `release-0.3.0-final/`             |
| 用户实测                   | 通过（目录选择/生成、长曲拖动、关于页、安装包启动）       |
| CI                         | 未推送；新增 Linux + Windows 工作流，等待 GitHub 实际运行 |

## 已完成（按时间倒序，只留结论）

- **0.3.0 用户实测通过**：重点流程无问题，包括目录选择与生成、长曲预览拖动、关于页和安装包启动。重启后清掉了旧 `win-unpacked` 文件锁，只保留 `release-0.3.0-final/` 候选产物。
- **0.3.0 本地候选**：Node 24 / Electron 45 / electron-builder 26.18 / Vitest 5 / Vite 8 / TypeScript 7.0.2 全量升级；TypeScript 7 用 `@typescript/typescript6` 并排满足 ESLint 的 TS 6 API 依赖。修复超长轨栈溢出、目录 token、块配置白名单、`SPATIAL_DRIFT` 定位、致命异常退出、许可证与模板；增加 Windows CI、Java 校验、Dependabot、Release 说明生成器和预览性能优化。286 用例、IPC 冒烟、界面、关于页、Java 校验和 Windows 打包全部通过。
- **问题清单整理**：新建 `docs/known-issues.md` 作为统一入口，按 `KI`（代码）、`REL`（产品限制）、`OPS`（版本与流程）编号；本文不再重复长清单。
- **0.2.5 发布**：普通多轨共享 X 参考线改为从实际补齐位置递推，修复长曲同时音无警告拉开；用户 27 轨《鸟之诗》最大间距 179→5 格，277 用例、界面、关于页、IPC 冒烟和 Windows 打包全部通过。安装包、便携版与资源包已上传 [GitHub Releases](https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.5)。
- **普通多轨对齐修复**：共享 X 参考线改为从各轨实际补齐后的位置递推，并使用与布线一致的尘埃容量；不再因丢弃历史补齐而让领先轨无警告超前。新增一个修复前为 X=62 对 X=55 的回归用例。用户提供的 27 轨《鸟之诗》同时发声最大 X 间距从 179 格降到 5 格，4604 个音群的实际中继器累计时序全部不变；完整生成 25066 字节、27 区域成功。`Rush E` 压力案例从 177 格降到 43 格，仍有容量警告，不宣称完全对齐。
- **0.2.4 发布**：把 0.2.3 tag 之后的审查修复打进安装包——IPC `GenerateOptions` 校验、`shell:open` 只允许 `.litematic`、外链前缀边界、拖拽已加载页面高亮、八度警告只报自动拟合、README 版本占位、CONTRIBUTING 浏览器说明；新增 `test/generateOptions.test.ts` 与拖拽/点击双路径 UI 测试。
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

### 0.3.0 本地候选资产（未发布）

- `release-0.3.0-final/MusicboxMC-Setup-0.3.0-win-x64.exe`（124,741,139 字节，SHA-256 `0310fec44f28808d96be5d885aa60f22c6d87314208a1117fc4ddfdbcfd800d0`）
- `release-0.3.0-final/MusicboxMC-0.3.0-win-x64.zip`（156,705,655 字节，SHA-256 `e741a4bcb7784d6fe698bf71146313ccaa5d115678291c14552e9c6bf9ad1e18`）
- `release-0.3.0-final/MusicboxMC-piano-pack-1.20.4.zip`（51,562 字节）
- 这三个文件只用于本地实测，没有上传，也没有对应 tag。

### 0.2.5 发布资产

- `release-0.2.5/MusicboxMC-Setup-0.2.5-win-x64.exe`（83,557,915 字节）
- `release-0.2.5/MusicboxMC-0.2.5-win-x64.zip`（114,629,586 字节）
- `release-0.2.5/MusicboxMC-piano-pack-1.20.4.zip`（51,562 字节）
- GitHub Release：[v0.2.5](https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.5)，tag 与 `package.json` 版本一致；三个资产的 GitHub SHA-256 与本地构建一致，状态均为 `uploaded`。

### 0.2.4 发布资产

- `release/MusicboxMC-Setup-0.2.4-win-x64.exe`（79.7 MB）
- `release/MusicboxMC-0.2.4-win-x64.zip`（109.3 MB）
- `release/MusicboxMC-piano-pack-1.20.4.zip`（51 KB）
- GitHub Release：[v0.2.4](https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.4)，tag 与 `package.json` 版本一致；三个资产均为 `uploaded`。

## 已知问题（诚实清单）

完整、可编号跟踪的清单见 [known-issues.md](known-issues.md)。0.3.0 已修复 `KI-01`～`KI-04`、`KI-06`、`OPS-01`、`OPS-04`～`OPS-08`、`OPS-10`、`OPS-11`。

仍未关闭：

1. `KI-05`：强制合并的全曲 compact/staged 切换，等用户决定。
2. `REL-01`：预览性能已优化且用户实测通过，保留为后续性能回归观察项。

本地前提：

- CI 不跑 `verify:ui` / `verify:about` / `smoke`，它们需要显示环境与真实 Electron。
- 本机若设置 `ELECTRON_RUN_AS_NODE=1`，跑 Electron 前必须删除。
- `out/` 是本地目录，不入库；中间文件放这里，不放 `/tmp`。

## 待用户决定

1. 是否提交、推送并发布 `0.3.0`。
2. `KI-05` 是否保留现状并增加提示。
