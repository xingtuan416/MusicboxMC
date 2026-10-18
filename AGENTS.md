# AGENTS.md

## 项目概览

把 MIDI 文件转成 Minecraft 红石音乐 `.litematic` 投影的桌面应用。Electron 33 + TypeScript 5.7（`strict`、`noUncheckedIndexedAccess`），渲染层是**无打包器、无框架的 ES 模块**。包管理器 **npm**（以 `package-lock.json` 为准），Node **>= 20**（CI 同时跑 20 与 22）。

数据流：`MIDI → SongModel → LayoutResult → RegionData[] → .litematic`。

## 常用命令

| 目的                                 | 命令                                                  |
| ------------------------------------ | ----------------------------------------------------- |
| 安装依赖                             | `npm ci`                                              |
| 构建（tsc + 拷贝渲染层/assets/图标） | `npm run build`                                       |
| 启动应用                             | `npm start`（内含 build）                             |
| 全量测试                             | `npm test`                                            |
| 单跑一个测试文件                     | `npx vitest run test/paddingBudget.test.ts`           |
| 单跑一个用例                         | `npx vitest run -t "reports a position relative"`     |
| 类型检查（含测试）                   | `npm run typecheck`                                   |
| lint                                 | `npm run lint` / `npm run lint:fix`                   |
| 格式化                               | `npm run format` / `npm run format:check`             |
| 不开界面直接生成                     | `npm run cli -- "song.mid"`                           |
| 校验资源包                           | `npm run resourcepack:check`                          |
| IPC 端到端冒烟（需先 build）         | `npm run smoke -- "song.mid"`                         |
| 打包 Windows 安装版                  | `npm run dist`（产物在 `release/`）                   |
| 界面全流程验证（需先 build）         | `npm run verify:ui`（截图到 `out/ui-shots/`）         |
| 关于页真机验证                       | `npm run verify:about`                                |
| 外部代码审查                         | `ocr review --from <ref> --to <ref> --audience agent` |

CI 跑 `npm ci` → `lint` → `typecheck` → `test` → `build`（`.github/workflows/ci.yml`，Node 20 与 22）。`verify:ui`、`verify:about`、`smoke` 需要显示环境，只能本地跑。

代码审查用阿里 OpenCodeReview（`ocr`，全局安装；配置在 `~/.opencodereview/config.json`，不在仓库里）。按路径的审查规则在 `.opencodereview/rule.json`，新发现的"会静默出错"的不变量应加进去。委托模式 `ocr delegate preview|rule` 不需要 API key。

## 目录地图

| 路径               | 说明                                                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/`        | 纯逻辑，不依赖 Electron：`midi` `layout` `palette` `litematic` `nbt` `tempo` `command`                                          |
| `src/main/`        | 主进程：`service`（编排）、`generate`、`analyze`、`messages`（错误码→中文）、`index`（窗口与 IPC）                              |
| `src/preload/`     | `contextBridge`，渲染层唯一入口                                                                                                 |
| `src/renderer/`    | 界面：`app.js`（全部行为）、`preview.js`（画布）、`warningText.js`、`resourcepack.js`、`index.html`                             |
| `scripts/`         | `copy-assets.mjs`、`cli.ts`、`check-piano-pack.mjs`、`smoke-ipc.cjs`、`verify-ui.cjs`、`verify-about.cjs`、`serve-renderer.cjs` |
| `test/`            | vitest；`fixtures/` 有 `.mid`、`.litematic` 与 Java 校验器                                                                      |
| `docs/`            | 架构、红石模型、litematic 格式、命令播放；**`status.md` 是当前项目状态，开工前先读**                                            |
| `.opencodereview/` | 按路径的代码审查规则（`ocr review` 使用）                                                                                       |
| `dist/` `release/` | **生成物，勿手改**                                                                                                              |
| `out/`             | 本地工作目录，已 gitignore，**勿提交**                                                                                          |

## 代码约定

配置为准，不要凭习惯：

- Prettier：`printWidth 110`、单引号、分号、尾逗号、LF。
- ESLint：`eqeqeq: smart`、`prefer-const`、`no-fallthrough`；未使用变量报错（`_` 开头豁免）；全角空格在字符串与模板里允许。
- TS：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters`、`noImplicitReturns`。
- EditorConfig：2 空格、LF、文件末尾换行。
- **代码注释写英文；界面文案写中文**（配置里没有这条，但全仓库一致；唯一例外是 `textEncoding.ts` 里的乱码示例数据）。

## 测试要求

- 测试只放 `test/**/*.test.ts`；`vitest.config.ts` 已排除 `dist`、`release`、`out`。
- 夹具放 `test/fixtures/`，**必须入库**。`*.mid`、`*.litematic` 在 `.gitignore` 里被忽略，靠 `!test/fixtures/*.mid`、`!test/fixtures/*.litematic` 例外放行；新增夹具要同时确认例外覆盖。
- 修 bug 必须附一条**修复前会失败**的测试。
- 格式类断言不能只靠自己读写往返：`test/fixtures/VerifyLitematic.java` 是按规范独立实现的校验器，`litematic` 的结构与位打包以它的输出为准。

## 与用户协作

- **MUST** 界面改动先交给用户测试再提交。自动化验证通过不等于手感对：本仓库的画布拖动曾两次"测试全绿但用户觉得不跟手"。提交前把改动留在工作区，说明改了哪几个文件、该怎么试。
- **MUST** 遇到自己无法理解、或试过仍解决不了的问题，向用户问明白再动手，并给出具体选项。猜错方向的成本高于问一句。
- **可以**在搜索不到资料、下载不通、需要账号或密钥时直接请用户帮忙，不要反复重试或绕路。
- **MUST** 定期把项目状态写进 `docs/status.md`（格式见下节），一次实质进展就更新一次。

### 状态文档写法

`docs/status.md` 固定六节，按此顺序，只写当前事实，不写过程叙事：

1. **一句话** —— 版本 + 正在做什么。
2. **位置** —— 版本号、分支、最新 Release、不要删的备份分支/标签。
3. **质量闸门** —— 表格：测试数、lint、typecheck、build、smoke、verify:ui、CI 状态，各写最近一次实测结果。
4. **已完成** —— 只留结论，按时间倒序，不写"我试了 A 又试了 B"。
5. **已知问题** —— 诚实清单，编号；每条写清现象与可能的修法。
6. **待用户决定** —— 编号，每条附上倾向的默认答案。

每条都要能被下一个人验证：写命令、写数字，不写"应该没问题"。

## 提交与 PR

- 分支 `main`；提交前缀用 `feat:` / `fix:` / `chore:` / `docs:` / `test:`。
- 一次提交一件事，信息写**为什么**，不写"改了哪些文件"。
- 不提交 `out/`、`dist/`、`release/`、任何 `.litematic` 产物。

## 硬性规则

1. **MUST** 用 `src/core/nbt/modifiedUtf8.ts` 处理所有 NBT 字符串。Java 用 Modified UTF-8 读字符串，普通 UTF-8 会让含 emoji 的文件被拒绝加载，而**中文在两种编码下字节相同**，所以自家读写往返测不出来。
2. **NEVER** 给轨道对齐的补齐段加中继器。红石粉零延迟、中继器有延迟；对齐依赖"用红石粉在空间上拉长而不动时间轴"，加中继器会让多轨越弹越散，且不报错。
3. **CRITICAL** 渲染层无法越过自己的目录取文件。`app://` 处理器把任何离开 `src/renderer/` 的路径当作越界并拒绝，界面需要的资源必须由 `scripts/copy-assets.mjs` 拷进去。
4. **NEVER** 把 URL 交给 `shell.openPath`，它只打开文件；外部链接走 `shell.openExternal`（否则点击毫无反应）。
5. **MUST** 高频事件里不要直接 `renderPreview`。重绘整张电路在长曲子上远超一帧，要累积增量并用 `requestAnimationFrame` 节流，否则拖动会跟不上光标。

## 常见故障

| 现象                                                     | 原因与处理                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `require('electron')` 返回一个字符串，`app` 是 undefined | 环境里有 `ELECTRON_RUN_AS_NODE=1`，跑 Electron 前删掉它             |
| `npm run smoke` 报找不到 `dist/src/main/index.js`        | 先 `npm run build`                                                  |
| 精确文本替换突然匹配不到                                 | 刚跑过 `npm run format`，Prettier 重排了；重新读文件再改            |
| 全新 clone 上测试数量比本地少                            | 某个夹具被 gitignore 了，检查 `!test/fixtures/...` 例外             |
| 界面某个按钮点了没反应，控制台无报错                     | 驱动它的 `state` 字段可能只在已删除的模块里赋值；检查赋值点是否可达 |
| 界面检查脚本报 404 `/icon.png`                           | 图标只在构建产物里，脚本服务的是源码目录；用构建后的目录回退        |

## 维护说明

以下情况必须回来改这个文件：新增或重命名 `package.json` 脚本；CI 步骤变化；发现新的"静默出错"不变量；新增需要代理知道的夹具或生成物目录。
