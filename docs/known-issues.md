# 已知问题与限制

> 基线版本：`0.2.5`  
> 最后更新：2026-11-14  
> 本文是后续修复工作的统一入口。`docs/status.md` 只保留当前状态摘要，不再重复完整问题清单。

## 使用方式

- `KI-*`：代码或运行时问题，可以定位到具体实现。
- `REL-*`：已经接受或暂时无法消除的产品限制，Release 页面也应引用这里。
- `OPS-*`：版本、规范、流程和仓库维护问题，不一定改代码。
- 级别：`P1` 需要优先处理，`P2` 应排期，`P3` 属于整理或说明问题。
- 状态：`待修`、`待确认`、`接受限制`、`待升级`、`已修复`、`部分完成`、`已改善`。
- 修复时在提交信息中引用编号，例如 `fix: prevent long-track stack overflow (KI-01)`。

## 已确认决策（2026-11-14）

- **D1**：全面跟进版本，目标是 Node 24、Electron 45 与当前构建/测试工具；不接受长期停留在旧主版本。
- **D2**：IPC 输出使用主进程发放的目录 token，渲染层不提交完整写盘路径。
- **D3**：Minecraft 兼容性按 Litematica 的 v6 数据结构与 DataFixer 能力表述，固定数据版本保持不变。
- **D4**：主进程发生未捕获异常时记录并退出，不继续运行。
- **D5**：Windows CI 每个 PR 跑 `check + dist:dir`，tag/手动发布时跑完整打包；UI 验证仍先保持本地。
- **D6**：允许清理旧 `release-*` 产物，并把 `*.iml` 加入忽略规则。
- **D7**：强制合并的全曲 compact/staged 选择暂缓，等解释后再决定。

## 摘要

| 编号   | 级别 | 状态     | 摘要                                            |
| ------ | ---- | -------- | ----------------------------------------------- |
| KI-01  | P1   | 已修复   | 超长单轨在导入分析时栈溢出                      |
| KI-02  | P1   | 已修复   | 主进程仍信任渲染层提供的输出路径和块配置        |
| KI-03  | P2   | 已修复   | `SPATIAL_DRIFT` 警告无法定位到轨和位置          |
| KI-04  | P3   | 已修复   | 关于 `package.json` 的注释与安装包事实相反      |
| KI-05  | P2   | 待确认   | 强制合并会被单个超宽和弦切换成全曲 staged 布局  |
| KI-06  | P2   | 已修复   | 主进程吞掉未捕获异常后继续运行                  |
| OPS-01 | P1   | 已修复   | `engines >=20` 与实际在 Node 24 下打包失败矛盾  |
| OPS-02 | P2   | 已修复   | Electron、Vitest、TypeScript 和 Node 长期未升级 |
| OPS-04 | P3   | 已修复   | 支持范围应按 Litematica v6/DataFixer 能力表述   |
| OPS-09 | P3   | 已修复   | 旧 release 产物清理与本地忽略规则               |
| OPS-10 | P3   | 已修复   | OpenCodeReview 覆盖不完整，仍有 3 条建议未处理  |
| OPS-11 | P2   | 已修复   | Windows-only 产品只在 Linux CI 上验证核心逻辑   |
| REL-01 | P2   | 已改善   | 长曲画布拖动性能                                |
| REL-02 | P2   | 接受限制 | 命令播放对命令方块、NBT 和区块加载有额外要求    |

完整条目见下文。

---

## 代码与运行时问题

### KI-01：超长单轨在导入分析时栈溢出

**级别**：P1  
**状态**：已修复（0.3.0）

**现象**：一条音轨的音符数达到约 12.5 万时，选择该 MIDI 后会在“分析”阶段直接失败，尚未进入布局生成。

**证据**：

- `src/main/analyze.ts:31-32` 对整条轨展开 `Math.min(...ticks)` / `Math.max(...ticks)`。
- `src/core/layout/index.ts:332` 对固定乐器轨再次展开 `Math.max(...midis)`。
- 实测单轨 125,000 个音符返回 `RangeError: Maximum call stack size exceeded`。
- 同类的 `warnings.push(...w)` 和合并轨的 `notes.push(...input.notes)` 也会在超长轨上溢出。
- `0.2.3` 已经在命令后端移除了同类展开，但上述位置仍然保留。

**影响**：文件无法导入，界面只能看到通用失败信息。正常歌曲很难达到这个规模，但项目已经支持 46k 音符的曲目，继续增长后会触发。

**修复方向**：改为一次循环扫描或 `reduce`；为分析阶段和固定乐器跨度检查各加一个超长轨回归测试。

### KI-02：主进程仍信任渲染层提供的输出路径和块配置

**级别**：P1  
**状态**：已修复（0.3.0）

**现象**：`options.ts` 明确写着“渲染层不可信”，但 `song:generate` 仍把渲染层传来的路径直接交给写盘函数。

**证据**：

- `src/main/index.ts:130-136` 接受任意非空 `outputPath`。
- `src/main/generate.ts:386` 直接 `writeFileSync(outputPath, buffer)`。
- `assertFile()` 只检查“文件存在”，不限制 `.mid` / `.midi`。
- `src/main/options.ts:65` 对 `blocks` 只判断是对象，随后直接强转为 `BlockOverrides`。
- `shell:reveal` 也接受任意存在的路径。

**影响**：当前渲染层不加载远程页面，并启用了 sandbox 和 context isolation，实际攻击面有限。但一旦渲染层出现 XSS 或被替换，恶意调用可以向任意可写路径覆盖文件。它与项目声明的 IPC 边界不一致。

**修复方向**：输出路径必须来自主进程目录对话框或短期授权令牌；限制扩展名和父目录；对 `blocks` 做逐字段白名单校验。主进程只根据授权结果写盘，不接受渲染层重新提交的绝对路径。

### KI-03：`SPATIAL_DRIFT` 警告无法定位

**级别**：P2  
**状态**：已修复（0.3.0）

**现象**：用户能看到“多轨对齐出现偏差”，但不知道是哪条轨、哪一段，也没有“在红石布线里定位”按钮。

**证据**：

- `src/core/layout/types.ts:117` 只包含 `tick` 和 `drift`。
- `src/core/layout/track.ts:227` 生成警告时没有携带 `trackIndex`、`x` 或 `z`。
- `src/renderer/warningText.js:124` 只能通过坐标或 `trackIndex` 查找位置。

**影响**：这条警告对普通用户几乎不可行动；在 `Rush E` 等容量不足的曲目上会一次出现大量相同提示。

**修复方向**：警告增加 `trackIndex`、`zBase`、`x`，并考虑把同一段连续偏差聚合而不是逐音群重复。

### KI-04：关于 `package.json` 的注释与安装包事实相反

**级别**：P3  
**状态**：已修复（0.3.0）

**证据**：

- `src/main/index.ts:183` 写着 `package.json` 不属于打包产物。
- `package.json:70-73` 明确包含 `package.json`。
- `release-0.2.5/win-unpacked/resources/app.asar` 内确实存在根目录 `package.json`。

**影响**：当前版本读取依赖它，功能没有问题；注释会误导后续维护者删除或改坏版本来源。

**修复方向**：修正注释，并说明为什么包内保留清单文件。

### KI-05：强制合并会被单个超宽和弦切换成全曲 staged 布局

**级别**：P2  
**状态**：待确认（D7，0.3.0 暂不处理）

**证据**：

- `src/core/layout/forced.ts:198` 使用 `groups.every(...)` 决定 `compact`。
- 只要全曲有一个音群超过紧凑容量，所有音群都会改用两行间隔的 staged fallback。
- 该模式还会给全曲增加统一分支延迟。

**影响**：一个局部极端和弦会改变整首曲子的结构尺寸和启动等待，用户很难从参数上预期。它是当前为了布线一致性做的全局选择，不一定应改成逐音群切换。

**修复方向**：先确认产品语义。如果保留全局切换，界面和文档必须明确说明；如果改成本地切换，需要重新验证主干高度、功率续接和全曲延迟一致性。

### KI-06：主进程吞掉未捕获异常后继续运行

**级别**：P2  
**状态**：已修复（0.3.0）

**证据**：`src/main/index.ts:244` 只把 `uncaughtException` 发给渲染层，没有退出、重启或恢复状态。

**影响**：Node 的默认终止行为被覆盖，主进程可能在内部状态已经损坏时继续接受操作。界面上只显示一条日志，用户会以为应用仍然正常。

**修复方向**：确认是否要“记录后退出”；更安全的做法是记录、通知界面并退出，至少不能静默继续执行关键 IPC。

---

## 版本、规范与流程问题

### OPS-01：Node 版本声明与实际打包能力矛盾

**级别**：P1  
**状态**：已修复（0.3.0）

**证据**：

- `package.json` 声明 `"engines": { "node": ">=20" }`。
- 本机 Node 24.22.2 执行 `npm run dist` 时，electron-builder 生成 `.ico` 的工具报 `WebAssembly.Memory(): could not allocate memory`。
- 同一流程在 Node 22.23.2 下成功。
- 项目文档和 CI 也只明确验证 Node 20 / 22。

**影响**：按 `engines` 安装 Node 24 的贡献者会遇到一个与业务代码无关的打包失败，错误信息也无法指向版本约束。

**0.3.0 结果**：electron-builder 升到 `26.18.0` 后，Node `24.22.2` 已成功生成 NSIS 安装包和便携 zip；`engines` 改为 `>=24`。首次构建时图标包下载曾因网络中断失败，重试后通过，不再是 WASM 分配错误。

### OPS-02：运行时和工具链长期停留在旧主版本

**级别**：P2  
**状态**：已修复（0.3.0）

**0.3.0 结果**：

- Node 升级到 24，CI 不再运行已停止维护的 Node 20。
- Electron 从 `33.4.11` 升到 `45.3.2`；electron-builder 升到 `26.18.0`。
- Vitest 升到 `5.1.0`，Vite 升到 `8.3.8`，ESLint 升到 `10.15.0`。
- TypeScript 7.0.2 已采用，并保留 `@typescript/typescript6` 作为 `typescript` 别名供 ESLint 使用；构建与类型检查显式调用 `typescript7/bin/tsc`。
- `tsconfig` 从已弃用的 `moduleResolution: node` 迁移到 `node16`。
- 仓库加入 Dependabot 周更分组。
- `@tonejs/midi 2.0.28` 仍是 npm 最新版，无需升级。

### OPS-03：补丁发布掩盖了维护债务

**级别**：P2  
**状态**：已处理（0.3.0 运行时升级 + Dependabot）

**0.3.0 结果**：运行时、构建器、测试框架和 CI 已整体升级，Dependabot 负责后续分组更新。该问题不再保留为未决债务。

**后续规则**：每个 Release 前检查一次 Node/Electron/测试框架的支持状态；大版本升级不与无关功能混在同一提交。

### OPS-04：支持范围应按 Litematica v6/DataFixer 能力表述

**级别**：P3  
**状态**：已修复（0.3.0）

**结论**：固定 `MinecraftDataVersion = 3700`、litematic `Version = 6` 不是缺陷，无需为了追随游戏版本改成动态 DataVersion。需要改的是 README 把“支持范围”错误地等同于 Minecraft 版本。

**证据**：

- `src/core/litematic/build.ts:30-31` 固定 `MinecraftDataVersion = 3700`、litematic `Version = 6`，对应 1.20.4。
- 当前 Litematica 26.3 分支定义 `SCHEMATIC_VERSION = 7`，读取时接受 `Version 1..7`，所以 v6 仍在支持范围：
  [LitematicaSchematic.java](https://github.com/sakura-ryoko/litematica/blob/26.3/src/main/java/fi/dy/masa/litematica/schematic/LitematicaSchematic.java)
- 当文件 `MinecraftDataVersion` 低于当前游戏时，它对 blockstate palette、方块实体和实体执行 Vanilla DataFixer 升级。
- 用户已实机验证 1.17.1–26.3 两端的对应组合，但支持条件应写成“文件结构 + Litematica 读取能力”，不是“游戏版本天然兼容”。

**影响**：用户会以为生成器跟随每个 Minecraft 版本更新，或误把加载失败归因于 `.litematic` 内容错误；实际取决于使用的 Litematica 版本是否接受 v6、是否执行 DataFixer，以及是否认识所用方块状态。

**0.3.0 结果**：

1. 保留 `Version 6 + DataVersion 3700`，没有引入动态 DataVersion。
2. README 中英文都已改为“输出 litematic v6，由对应 Litematica 读取并通过 DataFixer 升级旧数据版本”。
3. 保留用户实机验证的 Minecraft 1.17.1–26.3 范围，并把它绑定到对应 Litematica 组合。
4. 不加入铜制 trumpet 的理由不变：会破坏 v6 基线可用的方块集合。

### OPS-05：许可证展示不统一

**级别**：P3  
**状态**：已修复（0.3.0）

**证据**：

- `package.json` 是 `GPL-3.0-only`。
- README 徽章是 GPL-3.0-only。
- `src/main/index.ts:189` 的关于页硬编码为 `GPL-3.0`。
- `LICENSE` 是标准 GPLv3 文本。

**影响**：`GPL-3.0` 在 SPDX 语境下不如 `GPL-3.0-only` 明确，可能被理解为允许后续版本。项目自己的审查规则也要求不得出现“or later”的暗示。

**修复方向**：关于页统一显示 `GPL-3.0-only`，并加一条断言。

### OPS-06：独立 Java 校验器没有进入自动测试

**级别**：P2  
**状态**：已修复（0.3.0）

**证据**：

- `test/fixtures/VerifyLitematic.java` 被文档描述为格式权威。
- `test/litematic-roundtrip.test.ts:145-162` 只读取预置 `tiny.litematic` 并比较固定期望值，不执行 Java。
- 现有测试能防止自家实现漂移，但不能发现 Java 校验器本身与当前规范不一致。

**影响**：格式回归仍主要依赖人工运行一次 Java。CI 不会因为 Java 校验器失败而失败。

**修复方向**：在 CI 或本地 `npm run check` 的可选步骤中执行 Java；如果环境没有 JDK，至少把“未执行 Java”明确标成跳过原因，而不是让文档暗示已自动验证。

### OPS-07：Issue/PR 模板与实际流程脱节

**级别**：P3  
**状态**：已修复（0.3.0）

**证据**：

- `.github/ISSUE_TEMPLATE/bug_report.yml` 的版本占位仍是 `0.1.0`。
- `.github/PULL_REQUEST_TEMPLATE.md` 只列 `lint`、`typecheck`、`test`、`build`。
- `CONTRIBUTING.md` 和 CI 的统一闸门已经是 `npm run check`，其中还包含 `format:check`。

**影响**：贡献者按模板操作会漏掉格式检查；Issue 示例版本落后五个补丁版本。

**修复方向**：模板改成 `npm run check`，版本占位改成 `<version>` 或当前版本。

### OPS-08：状态、变更日志和 Release 说明存在三套重复叙事

**级别**：P3  
**状态**：已处理（0.3.0 增加 `release:notes`）

**现象**：同一个修复会同时写进 `CHANGELOG.md`、`docs/status.md` 的“已完成”和 GitHub Release body；Release 的已知限制又是第四份手工副本。`docs/status.md` 还把 GitHub 数据库 ID 写成 `run #43563003877`，与真正的 run number 不是一回事。

**影响**：内容容易漂移，发布时需要人工同步多处。这次的已知限制已集中到本文，但状态文档与 Release body 仍可能重复。

**0.3.0 结果**：新增 `npm run release:notes`，从 `CHANGELOG.md` 与本文的限制章节生成 Release body 草稿。下载表、文件大小和校验和仍由发布步骤追加，因为它们依赖实际构建产物。

### OPS-09：本地产物目录膨胀且部分本地文件未纳入忽略规则

**级别**：P3  
**状态**：已修复（0.3.0）

**0.3.0 结果**：

- `*.iml` 已加入 `.gitignore`。
- `release-0.2.3/`、`release-0.2.4/` 和 `release/` 中 0.2.1–0.2.4 的旧安装包已删除。
- 最新 `v0.2.5` 的已发布资产仍保留，当前发布资产与 `0.3.0` 候选产物分开存放。
- 用户重启 Windows 后，旧 `release/win-unpacked` 的系统文件锁已释放，残留目录已删除。

### OPS-10：OpenCodeReview 覆盖不完整，仍有 3 条建议未处理

**级别**：P3  
**状态**：已处理（0.3.0）

**0.3.0 处理结果**：

- `NOTE_BLOCK_INSTRUMENTS` 改由 `INSTRUMENT_ORDER` 显式定义，不再依赖对象键序。
- 复核后 `summarizeAssignments` 只被命令播放路径调用一次，不存在当前代码中的重复拟合，该条关闭。
- `span` 使用整轨原始音高跨度，`outside` 使用整轨八度拟合后的残余数量；已在代码中写清两者口径，保留现状。
- 后续审查仍应记录失败分组，不能用“全量通过”描述不完整结果。

### OPS-11：Windows-only 产品只在 Linux CI 上验证核心逻辑

**级别**：P2  
**状态**：已修复（0.3.0）

**证据**：

- 应用只发布 Windows x64 安装包和便携版，打包配置也只定义 `win` target。
- CI 只有 `runs-on: ubuntu-latest`，并设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。
- CI 不运行 `smoke`、`verify:ui`、`verify:about`，也不执行 `npm run dist`。
- Node 24 图标工具失败、Windows 文件锁等问题都只能在人工发布时暴露。

**影响**：CI 能证明 TypeScript 核心在 Linux Node 下可构建，却不能证明实际交付的 Windows 安装包可构建、可启动或版本号正确。发布质量依赖维护者本机环境和手工步骤。

**0.3.0 结果**：CI 增加 `windows-latest` job，每个 PR/main push 跑 `npm run check` + `npm run dist:dir`；tag 或手动触发时跑完整 `npm run dist` 并上传安装包、便携 zip 和资源包。UI 自动化仍保留在本地，因为需要真实桌面会话。

---

## 产品与游戏内已知限制

这些限制来自 Release 说明和设计文档，当前不具备简单的代码修复条件，或属于有意取舍。

### REL-01：长曲画布拖动不跟手

**级别**：P2  
**状态**：已改善（0.3.0 用户实测通过）

长曲预览原先每次拖动都会重新扫描全部预览格并在每帧重设画布缓冲区。0.3.0 为每个结果缓存非空格统计，只在画布尺寸变化时重建缓冲区；用户实测《鸟之诗》长曲拖动已通过。

后续仍保留为性能回归观察项。若未来更长的曲目再次出现卡顿，再评估可见区域离屏缓存或降低采样密度；这些改动必须继续由真实界面手感验证。

### REL-02：命令播放的额外运行要求

**级别**：P2  
**状态**：接受限制

命令播放需要：

- 命令方块已启用；
- 粘贴时保留方块实体 NBT；
- 整个结构位于已加载区块；
- 世界的 `maxCommandChainLength` 大于生成的链长；
- 客户端声音池能承受峰值同刻音符数。

命令播放不消除区块加载要求，只把电路变成更紧凑的命令链。

### REL-03：同一输入生成的播放器共用计分板命名空间

**级别**：P2  
**状态**：接受限制

两份输入和选项完全相同的命令播放器会生成相同命名空间，不能同时播放。重复生成并同时运行时，它们会覆盖彼此的 storage/scoreboard 状态。

### REL-04：超过 27 音的和弦在强制合并下使用 staged 两行总线

**级别**：P2  
**状态**：接受限制

普通布局会按列容量拆轨；强制合并为了保持单主轴，超过容量时退回两行间隔的 staged fallback。该路径会增加结构高度和全曲统一延迟，但不会丢音。

### REL-05：超大电路不保证区块加载、性能和听距

**级别**：P2  
**状态**：接受限制

生成器只描述静态方块和时序，不仿真：

- 区块加载和卸载；
- Minecraft 红石更新顺序；
- 客户端声音池；
- 音符盒听距；
- 服务器性能。

`Rush E` 这类超大电路即使生成成功，也可能因区块加载或声道距离听起来不完整。这是游戏内运行条件，不是 litematic 文件损坏。

### REL-06：不支持 1.21.2+ 铜制 trumpet，输出目标仍是 1.20.4

**级别**：P2  
**状态**：接受限制

项目使用 1.20.4 数据版本和 16 种经典音符盒乐器，不加入 1.21.2+ 的铜制 trumpet 变体。加入新方块会牺牲 1.17.1–1.20 的兼容性，目前没有这个计划。

### REL-07：布局不是红石模拟器

**级别**：P2  
**状态**：接受限制

`layout()` 生成静态方块和时序描述，不模拟 Minecraft 的方块更新顺序、红石网络隔离、区块加载或性能。强制合并有独立图校验，但同样不是完整游戏模拟。所有输出仍需在游戏中验证。

---

## 后续处理建议

1. **发布决定**：`0.3.0` 已通过用户重点实测，等待是否提交、推送和发布的指令。
2. **`KI-05`**：等用户决定是否只加“全曲 staged 布局”提示，还是接受逐音群混合的复杂改造。
3. **Release body**：发布时使用 `npm run release:notes`，再追加下载表、大小和校验和，避免手工复制变更日志与限制。
