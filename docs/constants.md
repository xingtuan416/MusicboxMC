# MusicboxMC 常量与阈值总表

这份表把仓库里**真实存在**的常量、阈值、上限全部列出来，并标出来源等级：

- **[游戏事实]**：由 Minecraft 规则决定，不是我们可以调的（例如 1 红石 tick = 2 游戏刻）。
- **[仓库约定]**：项目自己定的数值，改它等于改行为（例如 48 格听距阈值）。
- **[实现选择]**：为了让某个算法有边界/有容差而选的数值（例如 12 格对齐容差）。
- **[外部假设]**：为了适配外部环境（服务器规则、NBT 上限）而取的保守值。

数值都带 `文件:行`，可以直接核对。

## 一、时间与网格

| 量                    | 值                                                   | 来源                  | 位置                                                       |
| --------------------- | ---------------------------------------------------- | --------------------- | ---------------------------------------------------------- |
| 每游戏刻              | 20 TPS，1 tick = 50ms                                | [游戏事实]            | `src/core/tempo/tick.ts:2`、`:5`                           |
| MIDI 读入时的兜底 BPM | 120                                                  | [实现选择]            | `src/core/midi/parse.ts:7`                                 |
| 命令后端量化误差上限  | ±25ms（±½ 游戏刻）                                   | [实现选择]            | `src/core/tempo/tick.ts:12`                                |
| 红石后端量化误差上限  | ±75ms（1.5 游戏刻，两次取整）                        | [游戏事实]+[实现选择] | `src/core/tempo/tick.ts:14-23`                             |
| 单音符允许的触发偏差  | 1 游戏刻（超过报 `TIMING_ADJUSTED`）                 | [实现选择]            | `src/core/layout/model.ts:71`                              |
| 速度预设倍率          | 1.0 / 0.75 / 0.5 / 1.5 / 2.0（按 `/tick rate` 换算） | [仓库约定]            | `src/main/generate.ts:62`、`src/core/tempo/speed.ts:16-25` |

## 二、红石电路模型

| 量                   | 值                                                   | 来源            | 位置                                                                 |
| -------------------- | ---------------------------------------------------- | --------------- | -------------------------------------------------------------------- |
| 1 红石 tick          | 2 游戏刻 = 0.1 秒                                    | [游戏事实]      | `src/core/layout/model.ts:39`                                        |
| 单个中继器最大延迟   | 4 红石 tick = 8 游戏刻 = 0.4 秒                      | [游戏事实]      | `src/core/layout/model.ts:42`                                        |
| 红石粉满信号         | 15                                                   | [游戏事实]      | `src/core/layout/model.ts:45`                                        |
| 红石粉每格衰减       | −1                                                   | [游戏事实]      | `src/core/layout/model.ts:50-54`（注释）、`src/core/sim/redstone.ts` |
| 单侧最多分支行       | 14 行（= 15 − 1，远端的末级中继器至少还要 1 点信号） | [游戏事实] 推导 | `src/core/layout/model.ts:54`                                        |
| 单列最多和弦音       | 29 个（= 2×14 + 1：内联 1 + 两侧各 14 行）           | [游戏事实] 推导 | `src/core/layout/model.ts:54-57`                                     |
| 强制合并紧凑路径上限 | 27 个（= 2×(14−1)+1，且随 dMax 更小）                | [仓库约定]      | `src/core/layout/forced.ts:190-198`                                  |
| 用户可设的 dMax      | 1..14（超出被夹回；`chordCapacity` 把设置换成 2d+1） | [仓库约定]      | `src/core/layout/model.ts:60-64`、`src/main/options.ts:58`           |
| 默认 dMax            | 14                                                   | [仓库约定]      | `src/core/layout/index.ts:47`、`src/renderer/app.js:71`              |
| 电路层 / 地板层      | `circuitY = 1`、`floorY = 0`                         | [仓库约定]      | `src/core/layout/index.ts:45-46`                                     |
| 轨道默认中心距       | `auto`（= 每轨自己和弦行 + 恰好 1 行空白）           | [仓库约定]      | `src/core/layout/index.ts:48`、`672-711`                             |
| 音符盒单跳传导       | 只向相邻一格传电（≤3 音的和弦靠它）                  | [游戏事实]      | `src/core/layout/model.ts:31-35`、`187-215`                          |
| 音符盒是否导电       | 是：完整不透明方块，非导电例外名单里没有它           | [游戏事实]      | 第十八节（公开资料核对）                                             |

和弦上限有两个数，原因不同，别混：

- **29 是物理上限**：红石粉离供电格 d 行时信号是 15 − d，分支列最外侧那行还要给末级中继器留 ≥1 点输入，所以 d ≤ 14；1 个内联行 + 两侧各 14 行 = 29 个音（`2 × 14 + 1 = 29`）。用户把 dMax 调小，容量跟着变小：`2 × min(14, dMax) + 1`，默认 dMax 14 → 29。
- **超过 29 不是报错，是拆轨**：普通布局把多出来的音推到另一条轨道上，同时报 `POLYPHONY_EXCEEDED` 与 `TRACK_SPLIT`（`src/core/layout/groups.ts:205-221`、`src/core/layout/index.ts:751-755`）。
- **27 是强制合并紧凑路径的上限，不是物理上限**：紧凑列由入口/上一组经一格红石粉供电，根到达强度是 14 而不是 15，所以每侧只能 13 行（`2 × 13 + 1 = 27`），并且再受 dMax 限制：`min(2 × dMax + 1, 27)`（`src/core/layout/forced.ts:190-198`）。强制合并只有一条主线、没有第二条轨道可拆，所以任意一组超过这个数，**整条主线**就换成两行间隔的 staged 总线（更高、全曲统一延迟变长，但不丢音；见 `docs/known-issues.md` REL-04）。

## 三、空间对齐与补齐

| 量                     | 值                                                  | 来源            | 位置                               |
| ---------------------- | --------------------------------------------------- | --------------- | ---------------------------------- |
| 对齐容差（非同步时刻） | 12 格（注释明确：10–15 只是量级，不是某首歌的保证） | [实现选择]      | `src/core/layout/model.ts:86`      |
| 对齐容差（同步时刻）   | 0 格                                                | [实现选择]      | `src/core/layout/track.ts:292`     |
| 单段补齐上限           | 13 格（信号 15 留 1 格余量；只能用红石粉）          | [游戏事实] 推导 | `src/core/layout/model.ts:96`      |
| 补齐不够时             | 报 `SPATIAL_DRIFT`，不改时间                        | [仓库约定]      | `src/core/layout/track.ts:306-315` |
| 补齐格的分配           | 各槽轮询均分（每槽差 ≤1），最后一槽守分支列余量     | [实现选择]      | `src/core/layout/track.ts`         |

## 四、智能分流（30 / 48 阈值）

| 量                                   | 值                             | 来源                              | 位置                                   |
| ------------------------------------ | ------------------------------ | --------------------------------- | -------------------------------------- |
| 紧凑阈值：听距半径 < 30 格什么都不做 | 30 格                          | [仓库约定]                        | `src/main/smartSelection.ts:8`         |
| 听距阈值：能进 48 格半径的最窄者胜   | 48 格                          | [游戏事实] + [仓库约定]（见下节） | `src/main/smartSelection.ts:8`         |
| 「听距半径」的定义                   | 站行到最远音符盒的 Z 距离      | [仓库约定]                        | `src/core/layout/hearing.ts:25-44`     |
| 并列时的偏好顺序                     | 借道 → 同乐器合并 → 强制合并   | [仓库约定]                        | `src/main/smartSelection.ts:57-71`     |
| 候选是否可用                         | 必须实测宽度，不用估算         | [实现选择]                        | `src/main/smartSelection.ts:36-43`     |
| 同乐器 / 强制合并的适用范围          | 只对多乐器曲生效               | [仓库约定]                        | `src/main/smartSelection.ts:62-65`     |
| 强制合并时的借道 / 取电              | 两者都不适用，界面直接隐藏卡片 | [实现选择]                        | `src/renderer/app.js`（`syncSummary`） |

判据写在 `decideMerge`（`src/main/smartSelection.ts:50-72`）：不合并的**听距半径** < 30 → 不动；否则取所有半径 ≤ 48 的最窄候选；都进不了 48 就取最窄；若「不合并」本身最窄就保持不动。

「听距半径」（`hearingRadius`）是 2026-11-18 第十一轮引入的口径：玩家站在主音轨的红石粉那一行（`LayoutResult.playerZ`），半径取所有音符盒里离该行最远的 Z 距离（`src/core/layout/hearing.ts:25-44`）。在此之前用的是整条 Z 跨度（`size.z`），见第五节。

## 五、声音传播距离 —— 48 格是怎么回事

这是你点名要的一个数。2026-11-18 先用公开资料核对过（来源见第十八节），随后按你的指出把判据从“整条 Z 跨度”改成了“玩家到最远音符的半径”（第十一轮）。

- **48 格是游戏事实**：音符盒的声音固定以音量 3 播放，能听见的范围是 48 格。官方文章《方块周：音符盒》：「anyone within 48 blocks will hear a sound」；Wiki：「Notes can be heard up to 48 blocks away」；MCPE-164935 的开发者回复：「volume 3 … linear audible range of 48 blocks」。
- 仓库里用到 48 的地方只有 `SMART_RADIUS.audible = 48`（`src/main/smartSelection.ts:8`）。数值来自上面这条游戏事实，仓库里没有另外推导。
- **判据口径也是游戏事实的推论**：48 格是**以玩家为圆心**的半径，玩家站在中间时左右两侧各 48 格都听得见，总跨度 96 格仍然成立。所以代码用 `hearingRadius`（站行到最远音符盒的 Z 距离，`src/core/layout/hearing.ts:25-44`）跟 48 比，而不是拿 `size.z` 比。第十一轮之前比的是 `size.z`，会假报警：《鸟之诗》27 轨 `size.z = 59` 就报“超出听距”，实际最远音符只有 31 格。
- 站位不是猜的：`LayoutResult.playerZ` 就是主音轨的红石粉那一行（强制合并时是 spine 行），注释牌把它写给用户（`src/core/layout/annotation.ts:121-122`、`:174`）。
- 界面上现在显示“最远 N 格”（`hearingRadius`），不再叫“Z 向宽度”；生成路径把 `result.hearingRadius` 直接传给注释牌当 `spreadZ`（`src/main/generate.ts` 的 `laneLegend`），所以“牌上写的听距”与分流用的判据永远是同一个数；`planLaneAnnotation` 自己不传时才退回按轨道的 zMin/zMax 估（`src/core/layout/annotation.ts:164-169`）。
- 容易混淆但不同的量：**红石信号**最多传 15 格（含起点，`src/core/layout/model.ts:45`）；声音 48 格与红石 15 格没有关系。
- 仍可实测复核：创造模式平地放一个音符盒、敲一下、后退到听不见为止，用 F3 的坐标差量距离。如果你量出别的值，只改 `SMART_RADIUS.audible` 一个数（以及文档），不影响其它逻辑。

## 六、主音轨识别

| 量                 | 值                               | 来源       | 位置                                                         |
| ------------------ | -------------------------------- | ---------- | ------------------------------------------------------------ |
| 排序依据           | 平均力度（`meanVelocity`）降序   | [仓库约定] | `src/core/arrangement/prominence.ts:101-108`                 |
| 平局后的次序       | 音符数降序 → 文件里的轨道号升序  | [实现选择] | `src/core/arrangement/prominence.ts:101-108`                 |
| 打击乐是否参与     | 参与（只看力度，不看乐器类别）   | [仓库约定] | `src/core/arrangement/prominence.ts:110-111`                 |
| 力度取值范围       | 0–1（MIDI 力度归一化）           | [实现选择] | `src/core/midi/types.ts:9`                                   |
| 主音轨是否总是存在 | 是：智能开关、合并方式都不影响它 | [仓库约定] | `src/main/generate.ts`（`planLayout` 一律 `buildLaneOrder`） |

## 七、借道（稀疏音轨并轨）

| 量                   | 值                                      | 来源            | 位置                                                                        |
| -------------------- | --------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| 「稀疏」的音符数上限 | 50（少于 50 个音算稀疏）                | [仓库约定]      | `src/core/arrangement/laneSharing.ts:59`、`src/renderer/app.js:79`          |
| 收集轨最少音符数     | 50，且至少 2 条轨道                     | [仓库约定]      | `src/core/arrangement/laneSharing.ts:60`、`147-161`                         |
| 合并后能否再借       | 可以，但禁止新建收集轨                  | [仓库约定]      | `src/core/arrangement/laneSharing.ts:36-44`、`src/main/generate.ts:345-353` |
| 能否借的容量判据     | 叠加后每个 tick 的个数 ≤ `2 × dMax + 1` | [游戏事实] 推导 | `src/core/arrangement/laneSharing.ts:73-82`、`97`                           |
| 界面里可设的稀疏上限 | 1..500（超出不采信）                    | [仓库约定]      | `src/main/options.ts:11`、`:84-88`                                          |
| 折轨接受条件         | 轨道更少 且 听距半径 ≤ max(原半径, 48)  | [仓库约定]      | `src/main/generate.ts`（`attemptLaneFold`，已按第十一轮口径放宽）           |
| 借道接受条件         | 同上（`attemptShare`）                  | [仓库约定]      | `src/main/generate.ts`（`attemptShare`）                                    |

## 八、取电（消除长车头）

| 量                 | 值                                                           | 来源       | 位置                                  |
| ------------------ | ------------------------------------------------------------ | ---------- | ------------------------------------- |
| 值得借电的最短车头 | 24 格（目标位置 < 24 不借）                                  | [仓库约定] | `src/core/layout/index.ts:382`、`454` |
| 走廊每行代价       | 1 个中继器 = 1 红石 tick                                     | [游戏事实] | `src/core/layout/track.ts:244-261`    |
| 借电点读到的时刻   | `宿主该格时刻 + 走廊行数`                                    | [实现选择] | `src/core/layout/index.ts:469`        |
| 之后还要留的补齐链 | `ceil((首音时刻 − prevRt) / 4)`，且 `x + chain + 2 ≤ target` | [实现选择] | `src/core/layout/index.ts:484-485`    |
| 走廊可用条件       | 本行起点与走廊每格都空闲；走廊左右不能有中继器               | [游戏事实] | `src/core/layout/index.ts:471-483`    |
| 选列策略           | 最靠右（最晚）优先，同列取走廊最短                           | [实现选择] | `src/core/layout/index.ts:486-489`    |

## 九、注释牌

| 量               | 值                                                 | 来源       | 位置                                            |
| ---------------- | -------------------------------------------------- | ---------- | ----------------------------------------------- |
| 牌柱到电路的距离 | 3 格（西侧，牌朝 -X）                              | [仓库约定] | `src/core/layout/annotation.ts:83`              |
| 牌面行数         | 4 行                                               | [游戏事实] | `src/core/layout/annotation.ts:47`、`135-142`   |
| 底座材料         | 金块 = 主音轨 / 全曲主线；铜块 = 副轨 / 未指定主轨 | [仓库约定] | `src/core/layout/annotation.ts:88-94`           |
| 轨号标签         | ≤3 条源音轨写「轨 a+b+c」，否则「共 N 轨」         | [仓库约定] | `src/main/generate.ts:406-409`                  |
| 力度显示         | 该轨道最强源音轨平均力度 × 100 取整                | [仓库约定] | `src/main/generate.ts:410-413`                  |
| 玩家站位         | 主音轨的红石粉那一行（单主线＝spine 行）           | [仓库约定] | `src/core/layout/annotation.ts:121-122`、`:174` |
| 站位到副轨的距离 | 注释牌写「距主轨 N」＝两条轨道 zBase 之差的绝对值  | [仓库约定] | `src/core/layout/annotation.ts:144`、`:151`     |

## 十、乐器与音域

| 量                   | 值                                                                                                    | 来源       | 位置                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| 可用乐器             | 13 种带音高 + 3 种鼓（basedrum / snare / hat）                                                        | [游戏事实] | `src/core/palette/instruments.ts:20-37`、`158-175`                                   |
| 每个乐器起点的音高   | bass / didgeridoo F#1、guitar F#2、harp 一族 F#3、flute 与 cow_bell F#4、bell / chime / xylophone F#5 | [游戏事实] | `src/core/palette/instruments.ts:1-11`（注释）、`src/core/palette/pitchMap.ts:50-56` |
| 每个乐器的 MIDI 锚点 | bass 30、guitar 42、harp 54 … = 上面的起点按「MIDI 60 = C4」折算出的数字（详见本节说明）              | [仓库约定] | `src/core/palette/instruments.ts:44-45`、`58-155`                                    |
| 每个乐器覆盖         | 锚点起 24 个半音，共 25 个音高值（note 0..24）                                                        | [游戏事实] | `src/core/palette/instruments.ts:4`、`src/core/palette/pitchMap.ts:47-48`、`:236`    |
| 钢琴槽（extended）   | A=bass 30 / B=guitar 42 / C=harp 54 / D=flute 66 / E=bell 78 → F#1–F#7（MIDI 30–102）                 | [仓库约定] | `src/core/palette/pitchMap.ts:50-69`                                                 |
| 单槽钢琴（piano）    | 只有 C 槽（harp），F#3–F#5（54–78），不需要资源包                                                     | [仓库约定] | `src/core/palette/pitchMap.ts:85-88`                                                 |
| 通道号               | 通道 9（0 基；界面上的第 10 通道）是鼓                                                                | [游戏事实] | `src/core/midi/types.ts:11`、`src/core/midi/parse.ts:65`                             |

音域核对（2026-11-18，来源见第十八节）：标准音域 F#3–F#5，两个八度共 25 个音高，到顶回绕；低音乐器低两个八度（F#1–F#3）、长笛高一个八度（F#4–F#6）、铃 / 风铃 / 木琴高两个八度（F#5–F#7）。

**为什么「锚点」不能标成游戏事实**：游戏只知道「每个音符盒有 note 0..24，音高由它下面的方块决定」，它既没有 MIDI 这个概念，也不知道「30」是什么。30 / 42 / 54 / 66 / 78 是两层约定叠出来的：

1. **MIDI 编号约定**：行业习惯把 MIDI 60 记作 C4（也有把 60 记作 C3 的写法），按这个约定 F#1 才落在 30。换一种记法，五个锚点会整体平移 12，与游戏无关。
2. **本项目的映射选择**：按**绝对八度**决定一个音落到哪个乐器槽，于是五个槽正好铺满 F#1–F#7（MIDI 30–102）；换成「每个乐器都从自己最舒服的八度重新开始」也能出声，但同一首曲子的音域会被压缩或错位。这个选择写在 `src/core/palette/pitchMap.ts:50-69` 的注释里，替代过更早的 dirt / grass_block / bedrock 方案。

所以：**「每个乐器 25 个音高、起点是各乐器自己的 F#」是游戏事实；把起点折算成 MIDI 数字是本仓库的约定**。`Instruments` 表里的 `range` 字段只是 `锚点..锚点+24`（`src/core/palette/instruments.ts:46-47`）。

## 十一、导出格式

| 量                 | 值                                                               | 来源       | 位置                                 |
| ------------------ | ---------------------------------------------------------------- | ---------- | ------------------------------------ |
| 1.20.4 dataVersion | 3700                                                             | [游戏事实] | `src/core/litematic/build.ts:30`     |
| litematic 版本     | 6                                                                | [游戏事实] | `src/core/litematic/build.ts:31`     |
| 压缩               | gzip                                                             | [实现选择] | `src/core/litematic/build.ts:1`      |
| region 内方块索引  | `y × (sizeX × sizeZ) + z × sizeX + x`                            | [格式事实] | `src/core/litematic/build.ts:33-36`  |
| 每个 region        | 一条轨道一个（注释牌 +1）；被借道走廊穿过的高和弦轨道按 Z 行拆带 | [仓库约定] | `src/core/layout/regions.ts:162-175` |

两处核对（2026-11-18，来源见第十八节）：

- `Version = 6` 的合法区间是 dataVersion 2860（1.18，负 Y 高度）到 3836；3837（1.20.5，物品组件）起是 Version 7。1.20.4 = 3700 落在区间内，写 6 正确。
- 一个格式细节：Litematica 自家写入器从 dataVersion 3120（1.19.2）起会额外写 `SubVersion = 1`，本仓库只写 `Version` 与 `MinecraftDataVersion`（`src/core/litematic/build.ts:180-184`）。读取端把它当可选字段（nucleation 的读取器允许缺失，`test/fixtures/VerifyLitematic.java` 也接受），所以这是「与 Litematica 不完全一样但不会坏」的差异，记在这里以免以后误判成 bug。

## 十二、命令播放后端

| 量                              | 值                                                         | 来源       | 位置                                          |
| ------------------------------- | ---------------------------------------------------------- | ---------- | --------------------------------------------- |
| 命令链预算                      | 65536 条（保守取 1.20.4 的 gamerule 默认值；超了直接报错） | [外部假设] | `src/core/command/index.ts:35`                |
| 同时发声警告线                  | 31 个（原版音符盒复音边界）                                | [游戏事实] | `src/core/command/index.ts:38`                |
| 结构方块数警告线                | 4096 个（正常曲目远低于此；每音一命令的旧实现是 4.6 万）   | [仓库约定] | `src/core/command/index.ts:47-56`、`:161-166` |
| 命令链折叠边长                  | 32 格（每层 1024 个命令方块）                              | [实现选择] | `src/core/command/player.ts:14-18`            |
| 计分板最大值                    | 2147483646（int 上限 2147483647 会溢出成负数，故减一）     | [实现选择] | `src/core/command/schedule.ts:33`             |
| 单条 bootstrap 命令的 JSON 预算 | 24000 字节（NBT 字符串上限 65535，留余量）                 | [外部假设] | `src/core/command/commands.ts:16-23`          |

## 十三、红石模拟器

| 量             | 值                                  | 来源       | 位置                                                                            |
| -------------- | ----------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| 信号强度上限   | 15                                  | [游戏事实] | `src/core/sim/redstone.ts:98`                                                   |
| 中继器延迟单位 | 1..4 红石 tick → 2..8 游戏刻        | [游戏事实] | `src/core/sim/redstone.ts`（`fireDueRepeaters`）、`src/core/layout/model.ts:42` |
| 未加载区块     | 信号停住，中继器到期重排到下一 tick | [仓库约定] | `src/core/sim/redstone.ts`（`syncChunks` / `waiting`）                          |

## 十四、输入上限（渲染层不可信，主进程夹紧）

| 量                          | 值       | 位置                               |
| --------------------------- | -------- | ---------------------------------- |
| 排除轨道 / 移调表的键数上限 | 4096     | `src/main/options.ts:8`            |
| 速度预设条数上限            | 32       | `src/main/options.ts:9`            |
| 作者名长度上限              | 100 字符 | `src/main/options.ts:10`           |
| 稀疏上限的合法区间          | 1..500   | `src/main/options.ts:11`、`:84-88` |
| dMax 合法区间               | 1..14    | `src/main/options.ts:58`           |
| 输出目录授权数上限          | 64       | `src/main/outputPaths.ts:14`       |
| 文件名长度上限              | 180 字符 | `src/main/outputPaths.ts:19`       |

## 十五、界面与性能参数

| 量                            | 值             | 位置                                        |
| ----------------------------- | -------------- | ------------------------------------------- |
| 预览基础格宽                  | 38 px          | `src/renderer/previewGeometry.js:16`        |
| 预览左槽 / 标尺               | 150 px / 28 px | `src/renderer/previewGeometry.js:18`、`:20` |
| 格宽范围                      | 4–72 px        | `src/renderer/previewGeometry.js:28-29`     |
| 细节层最小格宽 / 徽标最小格宽 | 24 / 26 px     | `src/renderer/previewGeometry.js:38`、`:41` |
| 可读字号对应格宽              | 28 px          | `src/renderer/preview.js:26`                |
| 画布最小尺寸                  | 320 × 200 px   | `src/renderer/preview.js:35-36`             |
| 区域配色数                    | 7              | `src/renderer/preview.js:39`                |
| 预览瓦片边长                  | 384 px         | `src/renderer/previewGeometry.js:103`       |
| 瓦片缓存张数                  | 16（LRU）      | `src/renderer/preview.js:48`                |
| 提示条数显示上限              | 500            | `src/renderer/warningText.js:14`            |
| 开发者日志上限                | 400 条         | `src/renderer/devmode.js:13`                |
| 单页问题数                    | 4              | `src/renderer/app.js:1299`                  |
| 折叠区底部留白                | 18 px          | `src/renderer/app.js:432`                   |

## 十六、界面默认值（`state`）

| 字段                     | 默认值          | 位置                        |
| ------------------------ | --------------- | --------------------------- |
| 乐器模式                 | `extended`      | `src/renderer/app.js:70`    |
| dMax                     | 14              | `src/renderer/app.js:71`    |
| 超范围策略               | `warn`          | `src/renderer/app.js:72`    |
| 后端                     | `redstone`      | `src/renderer/app.js:73`    |
| 合并方式                 | `off`           | `src/renderer/app.js:75`    |
| 智能选择                 | 开              | `src/renderer/app.js:53`    |
| 借道                     | 开，稀疏上限 50 | `src/renderer/app.js:77-79` |
| 主轨居中 / 注释牌 / 取电 | 全开            | `src/renderer/app.js:81-84` |
| 作者名                   | `MusicboxMC`    | `src/renderer/app.js:85`    |
| 命令链预算               | 65536           | `src/renderer/app.js:86`    |
| baseTps                  | 20              | `src/renderer/app.js:87`    |

## 十七、我没把握、需要你确认或实测的

1. ~~**48 格听距的口径**~~ —— 第十一轮已按你的指出改成“玩家站行到最远音符盒的半径”（`hearingRadius`），不再是整首歌的 Z 跨度；数值本身也是已核实的游戏事实（第四、五、十八节）。
2. **区块加载半径**：项目**没有**假设任何具体区块半径；之前探针里用的「半径 11 区块」只是按服务器默认模拟距离估的实验参数，不是代码常量。
3. **服务器 `maxCommandChainLength`**：65536 取的是原版默认值；服务器可能调过，超了命令链会静默截断（这一点模拟器与测试都不覆盖）。
4. **30 格紧凑阈值**：是「合并开始有意义的听距」的工程判断，没有游戏依据；如果你觉得 20 或 40 更合适，只改 `SMART_RADIUS.compact`。注意现在比较的是听距半径（玩家到最远音符），不是投影宽度。
5. **12 格对齐容差**：代码注释明确它只是「检查间隔的数量级」，不是任何一首歌的最坏情况保证（`src/core/layout/model.ts:82-86`）。

## 十八、公开资料核对结果（2026-11-18）

按你的要求用网络公开资料核对了这份表里能查证的常量。逐条结论如下，结论是「已核实」的条目，上文的来源等级才按游戏事实计。

| 常量 / 说法                                                     | 核对结论                                                                      | 公开来源                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 音符盒可听 48 格                                                | ✅ 吻合。声音固定以音量 3 播放，线性可听范围 48 格                            | 官方《方块周：音符盒》（minecraft.net/zh-hans/article/block-week-note-block）；Wiki Note Block「Notes can be heard up to 48 blocks away」；MCPE-164935 开发者回复「Java is hardcoded to play them with volume 3 … linear audible range of 48 blocks」（mojira.dev/MCPE-164935） |
| 1 红石 tick = 2 游戏刻 = 0.1 秒                                 | ✅ 吻合                                                                       | ncesc.com「How many ticks is a repeater」；wikily.gg「A redstone tick is 2 game ticks (0.1 seconds)」                                                                                                                                                                           |
| 中继器延迟 1–4 红石 tick                                        | ✅ 吻合                                                                       | 同上两篇                                                                                                                                                                                                                                                                        |
| 红石粉信号 15、每格 −1                                          | ✅ 吻合                                                                       | Microsoft Learn 红石指南「starts at 15 and decreases by 1 for each block」；wikily.gg                                                                                                                                                                                           |
| 红石粉传导零延迟（同一游戏刻内完成）                            | ✅ 吻合                                                                       | mc-mod.net「iteratively decreases its signal strength by one … within a single game tick」                                                                                                                                                                                      |
| 音符盒 25 个音高、F#3–F#5 两个八度、到顶回绕                    | ✅ 吻合                                                                       | Wiki Note Block；1337wiki「25 distinct pitches」；百度百科音符盒                                                                                                                                                                                                                |
| 乐器音域偏移：低音低 2 个八度、长笛高 1 个、铃/风铃/木琴高 2 个 | ✅ 吻合（对应锚点 30 / 42 / 54 / 66 / 78）                                    | Wiki Note Block「the flute is one octave above the standard range, and the bells, chimes and xylophone are 2 octaves above」                                                                                                                                                    |
| 音符盒是导体，会把电传给相邻红石粉                              | ✅ 吻合。导电方块＝完整不透明方块，非导电例外名单里只有红石块、侦测器、活塞等 | bermotech 红石交互一文「Strongly powered blocks will power redstone dust adjacent to them」；mineuniverse 导电性词条                                                                                                                                                            |
| 1.20.4 的 dataVersion = 3700                                    | ✅ 吻合                                                                       | docs.rs mcdata「pub const MC_1_20_4: u32 = 3700」；nurshia.com 版本表                                                                                                                                                                                                           |
| 1.20.4 应写 litematic Version 6                                 | ✅ 吻合。2860（1.18）起 Version 6，3837（1.20.5）起 Version 7                 | docs.rs nucleation litematic 模块源码注释；litematica-rust 格式说明                                                                                                                                                                                                             |
| Litematica 从 1.19.2 起多写 SubVersion=1，本仓库不写            | ⚠️ 差异（不是错误）。读取端视为可选字段                                       | 同上：nucleation 注释「DATA_VERSION_1_19_2: i32 = 3120; // SubVersion=1 first written (within v6)」                                                                                                                                                                             |
| NBT 字符串最长 65535 字节，且是 Modified UTF-8                  | ✅ 吻合。TAG_String 长度字段是 u2                                             | formats.kaitai.io Minecraft NBT；Pumpkin「exceeds u16::MAX bytes (65535)」                                                                                                                                                                                                      |
| 命令链上限默认 65536                                            | ✅ 数值吻合，但仍属外部假设（服务器可改）                                     | mcmod.cn gamerule maxCommandChainLength 词条                                                                                                                                                                                                                                    |
| 计分板是 32 位整数，2147483647 会溢出                           | ✅ 吻合（MC-79954）。代码取 2147483646 是刻意留一位，来源等级改为实现选择     | mojira.dev/MC-79954                                                                                                                                                                                                                                                             |

仍然没有公开资料能替我们回答、只能靠你自己的服务器或手感判断的：区块加载半径（项目不假设）、服务器是否改过 `maxCommandChainLength`、30 格紧凑阈值、12 格对齐容差。
