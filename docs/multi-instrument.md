# 多乐器支持（设计稿，待评审）

> 状态：已按本设计实现，待用户真机/界面测试后提交。设计记录保留，便于以后查锚点与规则。
> 最后更新：2026-10-18

## 1. 背景

### 1.1 现在怎么工作

现在生成器不读 MIDI 轨道自己的乐器，而是**按音高**把每个音分给 A–E 五个槽：

| 槽  | 底块     | 音色   | 锚点           |
| --- | -------- | ------ | -------------- |
| A   | 橡木木板 | bass   | F#1（MIDI 30） |
| B   | 白色羊毛 | guitar | F#2（MIDI 42） |
| C   | 泥土     | harp   | F#3（MIDI 54） |
| D   | 黏土     | flute  | F#4（MIDI 66） |
| E   | 金块     | bell   | F#5（MIDI 78） |

这套设计是为**纯钢琴曲**服务的：一架钢琴的音域超过两个八度，所以用五个槽拼出 F#1–F#7，再靠配套资源包把这五段统一成钢琴采样。

`TrackModel.instrument` 和 `percussion` 目前只在「同名乐器合并」时用作分组 key（`percussion` 也会显示在选轨页），不会进入音符盒的 `instrument` 属性。

### 1.2 一个容易混淆的事实：Minecraft 没有钢琴音色

原版**没有**叫「钢琴」的音符盒乐器。泥土（以及大多数非乐器方块）下面的音符盒发的是 **harp（竖琴）** 采样；它和钢琴最接近，教程和社区普遍把它当钢琴用，很多教程干脆把两者混着说。本项目的「钢琴音色」一直指的是「harp 采样 + 配套资源包对这五个槽的钢琴替换」，不是原版存在钢琴。

这条要写进文档和代码注释，避免以后再把 harp 写成 piano。

### 1.3 目标

- 让每条 MIDI 轨按它真正的乐器发声，覆盖 16 种原版乐器（13 种有音高 + 3 种固定音高鼓）。
- 保留现有的「扩展竖琴音域」能力，纯钢琴文件的行为不变。
- 两种模式可以在界面上切换，默认「扩展竖琴音域」。
- 红石后端和命令方块后端都支持。
- 提供可回归的 16 轨测试夹具。

### 1.4 非目标

- 不做 1.21.2+ 的 4 种铜制 trumpet（trumpet / exposed / weathered / oxidized）。项目 litematic 数据版本是 1.20.4，加它们会牺牲 1.17.1–1.20 的兼容性。
- 不做 mob head 乐器、不做自定义音色包。
- 不改电路拓扑、时序、对齐算法。
- 不在这一轮做「每条轨手动改乐器」的 UI；先做自动识别 + 只读展示（评审点 7）。

## 2. 两种模式

### 2.1 原版乐器

每条轨按识别出的乐器发声，各用各的底块，各限定在自己的两个八度内。钢琴轨就是 harp，F#3–F#5。

### 2.2 扩展竖琴音域（默认）

- **钢琴 / 未识别轨**：沿用现在的五槽扩展，按音高分到 A–E，覆盖 F#1–F#7。
- **其余 11 种乐器**（chime、xylophone、iron_xylophone、cow_bell、didgeridoo、bit、banjo、pling、basedrum、snare、hat）：保持原版音色，正常播放。
- **原生落在被占用的 5 种乐器上的轨道**（bass、guitar、flute、bell）：不强行改回钢琴，而是换成音色/音域最接近的**空闲**乐器，见 3.3。这是你补充的「找相近音色来替，比用竖琴替换好听」。
- **原生 harp**：它就是钢琴音色本身，直接走五槽扩展。

### 2.3 模式对照

| 识别结果               | 原版乐器模式   | 扩展竖琴音域模式   |
| ---------------------- | -------------- | ------------------ |
| harp / 未识别          | harp           | 五槽钢琴扩展       |
| bass                   | bass           | didgeridoo（替代） |
| guitar                 | guitar         | banjo（替代）      |
| flute                  | flute          | bit（替代）        |
| bell                   | bell           | chime（替代）      |
| chime                  | chime          | chime              |
| xylophone              | xylophone      | xylophone          |
| iron_xylophone         | iron_xylophone | iron_xylophone     |
| cow_bell               | cow_bell       | cow_bell           |
| didgeridoo             | didgeridoo     | didgeridoo         |
| bit                    | bit            | bit                |
| banjo                  | banjo          | banjo              |
| pling                  | pling          | pling              |
| basedrum / snare / hat | 原样           | 原样               |

### 2.4 资源包

配套资源包仍然保留，只服务于「扩展竖琴音域」的五槽。它替换的是 bass / guitar / harp / flute / bell 五个 sound event，所以：

- 扩展模式：装包后五槽听起来像同一架钢琴，推荐安装。
- 原版模式：**不建议装**。装了以后，原生的 bass / guitar / flute / bell 也会被替换成钢琴，反而不是原版音色。界面要在原版模式下提示这一点，并且只在扩展模式导出后弹「保存资源包」的提示。

## 3. 乐器数据

### 3.1 16 种乐器

数据来源：[Minecraft Wiki: Note Block](https://minecraft.wiki/w/Note_Block)。锚点是 `note=0` 时对应的 MIDI 音高。

| 乐器           | 底块             | 音域    | 锚点 | 有音高 |
| -------------- | ---------------- | ------- | ---- | ------ |
| harp           | 泥土（多数方块） | F#3–F#5 | 54   | 是     |
| bass           | 木头             | F#1–F#3 | 30   | 是     |
| didgeridoo     | 南瓜             | F#1–F#3 | 30   | 是     |
| guitar         | 羊毛             | F#2–F#4 | 42   | 是     |
| flute          | 黏土             | F#4–F#6 | 66   | 是     |
| cow_bell       | 灵魂沙           | F#4–F#6 | 66   | 是     |
| bell           | 金块             | F#5–F#7 | 78   | 是     |
| chime          | 浮冰             | F#5–F#7 | 78   | 是     |
| xylophone      | 骨块             | F#5–F#7 | 78   | 是     |
| iron_xylophone | 铁块             | F#3–F#5 | 54   | 是     |
| bit            | 绿宝石块         | F#3–F#5 | 54   | 是     |
| banjo          | 干草块           | F#3–F#5 | 54   | 是     |
| pling          | 萤石             | F#3–F#5 | 54   | 是     |
| basedrum       | 石头             | 无      | —    | 否     |
| snare          | 沙子             | 无      | —    | 否     |
| hat            | 玻璃             | 无      | —    | 否     |

### 3.2 固定音高鼓

basedrum / snare / hat 的音高由采样固定，`note` 值不影响发声。生成时统一写 `note=0`，命令后端用 `pitch=1`。

### 3.3 扩展模式的替代表（待确认）

| 原生乐器 | 扩展模式替代 | 理由                                                                     |
| -------- | ------------ | ------------------------------------------------------------------------ |
| bass     | didgeridoo   | 同为 F#1–F#3 的低音；didgeridoo 是空闲乐器                               |
| guitar   | banjo        | 同为拨弦；banjo 是空闲乐器                                               |
| flute    | bit          | bit 是单簧管/合成音色，最接近管乐；cow_bell 音域相同但音色是钟，列为备选 |
| bell     | chime        | 同为钟琴类，音域完全相同                                                 |
| harp     | 不替代       | harp 就是钢琴扩展本身                                                    |

替代只发生在「扩展竖琴音域」模式；原版模式全部用原生乐器。

## 4. 乐器识别

### 4.1 优先级

按你的要求，GM 音色优先，其次鼓通道，再其次轨道名，最后 harp。但通道 9 要特殊处理：它的 GM 音色是「架子鼓」，不能拿去查旋律乐器表。

实际规则：

1. **通道 9（打击乐）**
   - 音符 35/36 → basedrum
   - 38/40 → snare
   - 42/44/46 → hat
   - 不在这三组里的音符：查轨道名；名字能识别成有音高乐器就用（例如 Cow Bell → cow_bell）；否则丢弃，并汇总一条警告。
2. **非通道 9**
   - GM 音色号查 4.4 的表；查到就用。
   - 查不到（音色号缺失或不在表里）→ 查轨道名。
   - 都不行 → harp。
3. 轨道名为空、叫「主旋律」「伴奏」这类不带乐器名的，不影响 GM 优先；只有在 GM 缺失时才看名字。

补充：`@tonejs/midi` 在解析时已经按 `(program, channel)` 拆分轨道（`splitTracks`），所以 Format 0 里一条 MTrk 含多个乐器时，进入本项目时已经是多条 `TrackModel`，按轨识别仍然成立。

### 4.2 通道 9 的例外

你这份文件的 Cow Bell 在通道 9，但 Cow Bell 是有音高乐器。规则保证它不会因为通道 9 被当成鼓丢掉：鼓音符表里没有 56，于是落到「查轨道名」，名字命中 Cow Bell。

### 4.3 轨道名别名（按最长匹配优先）

匹配时先查最具体的词，避免「Bass Drum」被当成「Bass」、「Iron Xylophone」被当成「Xylophone」、「Cow Bell」被当成「Bell」。英文按词边界匹配，避免「Contrabass」误中「bass」；中文按子串匹配。

| 乐器           | 英文别名                                                               | 中文别名                 |
| -------------- | ---------------------------------------------------------------------- | ------------------------ |
| basedrum       | bass drum, basedrum, bassdrum, kick                                    | 底鼓, 大鼓               |
| snare          | snare                                                                  | 军鼓, 小鼓               |
| hat            | hi-hat, hihat, click, hat                                              | 踩镲, 镲                 |
| iron_xylophone | iron xylophone, vibraphone                                             | 铁木琴, 颤音琴           |
| cow_bell       | cow bell, cowbell                                                      | 牛铃                     |
| xylophone      | xylophone, marimba                                                     | 木琴, 马林巴             |
| chime          | chime, glockenspiel                                                    | 钟琴                     |
| bell           | bell, tubular bells, bells                                             | 铃, 钟                   |
| flute          | flute, piccolo, recorder                                               | 长笛, 短笛, 竖笛         |
| guitar         | guitar                                                                 | 吉他                     |
| banjo          | banjo, sitar, shamisen, koto                                           | 班卓, 西塔琴, 三味线, 筝 |
| didgeridoo     | didgeridoo                                                             | 迪吉里杜管               |
| bit            | bit, square, synth                                                     | 比特, 方波, 合成         |
| pling          | pling, electric piano, e.piano, e. piano                               | 电钢琴                   |
| bass           | bass                                                                   | 贝斯, 低音               |
| harp           | harp, piano, harpsichord, violin, viola, fiddle, organ, choir, strings | 竖琴, 钢琴               |

完整别名表以 `src/core/palette/instrumentMap.ts` 为准；这里只列常用项。

### 4.4 GM 128 音色映射表（待逐行确认）

| #   | GM 音色                 | 音符盒乐器     |
| --- | ----------------------- | -------------- |
| 0   | Acoustic Grand Piano    | harp           |
| 1   | Bright Acoustic Piano   | harp           |
| 2   | Electric Grand Piano    | harp           |
| 3   | Honky-tonk Piano        | harp           |
| 4   | Electric Piano 1        | pling          |
| 5   | Electric Piano 2        | pling          |
| 6   | Harpsichord             | harp           |
| 7   | Clavinet                | pling          |
| 8   | Celesta                 | chime          |
| 9   | Glockenspiel            | chime          |
| 10  | Music Box               | pling          |
| 11  | Vibraphone              | iron_xylophone |
| 12  | Marimba                 | xylophone      |
| 13  | Xylophone               | xylophone      |
| 14  | Tubular Bells           | bell           |
| 15  | Dulcimer                | banjo          |
| 16  | Drawbar Organ           | harp           |
| 17  | Percussive Organ        | harp           |
| 18  | Rock Organ              | bit            |
| 19  | Church Organ            | harp           |
| 20  | Reed Organ              | harp           |
| 21  | Accordion               | bit            |
| 22  | Harmonica               | bit            |
| 23  | Tango Accordion         | bit            |
| 24  | Acoustic Guitar (nylon) | guitar         |
| 25  | Acoustic Guitar (steel) | guitar         |
| 26  | Electric Guitar (jazz)  | guitar         |
| 27  | Electric Guitar (clean) | pling          |
| 28  | Electric Guitar (muted) | guitar         |
| 29  | Overdriven Guitar       | bit            |
| 30  | Distortion Guitar       | bit            |
| 31  | Guitar Harmonics        | pling          |
| 32  | Acoustic Bass           | bass           |
| 33  | Electric Bass (finger)  | bass           |
| 34  | Electric Bass (pick)    | bass           |
| 35  | Fretless Bass           | bass           |
| 36  | Slap Bass 1             | bass           |
| 37  | Slap Bass 2             | bass           |
| 38  | Synth Bass 1            | bass           |
| 39  | Synth Bass 2            | bass           |
| 40  | Violin                  | harp           |
| 41  | Viola                   | harp           |
| 42  | Cello                   | didgeridoo     |
| 43  | Contrabass              | didgeridoo     |
| 44  | Tremolo Strings         | harp           |
| 45  | Pizzicato Strings       | guitar         |
| 46  | Orchestral Harp         | harp           |
| 47  | Timpani                 | basedrum       |
| 48  | String Ensemble 1       | harp           |
| 49  | String Ensemble 2       | harp           |
| 50  | SynthStrings 1          | harp           |
| 51  | SynthStrings 2          | harp           |
| 52  | Choir Aahs              | harp           |
| 53  | Voice Oohs              | harp           |
| 54  | Synth Voice             | harp           |
| 55  | Orchestra Hit           | basedrum       |
| 56  | Trumpet                 | bit            |
| 57  | Trombone                | didgeridoo     |
| 58  | Tuba                    | didgeridoo     |
| 59  | Muted Trumpet           | bit            |
| 60  | French Horn             | bit            |
| 61  | Brass Section           | bit            |
| 62  | SynthBrass 1            | bit            |
| 63  | SynthBrass 2            | bit            |
| 64  | Soprano Sax             | bit            |
| 65  | Alto Sax                | bit            |
| 66  | Tenor Sax               | bit            |
| 67  | Baritone Sax            | bit            |
| 68  | Oboe                    | bit            |
| 69  | English Horn            | bit            |
| 70  | Bassoon                 | didgeridoo     |
| 71  | Clarinet                | bit            |
| 72  | Piccolo                 | flute          |
| 73  | Flute                   | flute          |
| 74  | Recorder                | flute          |
| 75  | Pan Flute               | flute          |
| 76  | Blown Bottle            | flute          |
| 77  | Shakuhachi              | flute          |
| 78  | Whistle                 | flute          |
| 79  | Ocarina                 | flute          |
| 80  | Lead 1 (square)         | bit            |
| 81  | Lead 2 (sawtooth)       | bit            |
| 82  | Lead 3 (calliope)       | bit            |
| 83  | Lead 4 (chiff)          | bit            |
| 84  | Lead 5 (charang)        | bit            |
| 85  | Lead 6 (voice)          | bit            |
| 86  | Lead 7 (fifths)         | bit            |
| 87  | Lead 8 (bass + lead)    | bit            |
| 88  | Pad 1 (new age)         | harp           |
| 89  | Pad 2 (warm)            | harp           |
| 90  | Pad 3 (polysynth)       | harp           |
| 91  | Pad 4 (choir)           | harp           |
| 92  | Pad 5 (bowed)           | harp           |
| 93  | Pad 6 (metallic)        | chime          |
| 94  | Pad 7 (halo)            | chime          |
| 95  | Pad 8 (sweep)           | chime          |
| 96  | FX 1 (rain)             | pling          |
| 97  | FX 2 (soundtrack)       | chime          |
| 98  | FX 3 (crystal)          | chime          |
| 99  | FX 4 (atmosphere)       | chime          |
| 100 | FX 5 (brightness)       | pling          |
| 101 | FX 6 (goblins)          | bit            |
| 102 | FX 7 (echoes)           | pling          |
| 103 | FX 8 (sci-fi)           | pling          |
| 104 | Sitar                   | banjo          |
| 105 | Banjo                   | banjo          |
| 106 | Shamisen                | banjo          |
| 107 | Koto                    | banjo          |
| 108 | Kalimba                 | pling          |
| 109 | Bag Pipe                | didgeridoo     |
| 110 | Fiddle                  | harp           |
| 111 | Shanai                  | bit            |
| 112 | Tinkle Bell             | bell           |
| 113 | Agogo                   | cow_bell       |
| 114 | Steel Drums             | xylophone      |
| 115 | Woodblock               | hat            |
| 116 | Taiko Drum              | basedrum       |
| 117 | Melodic Tom             | basedrum       |
| 118 | Synth Drum              | snare          |
| 119 | Reverse Cymbal          | hat            |
| 120 | Guitar Fret Noise       | guitar         |
| 121 | Breath Noise            | flute          |
| 122 | Seashore                | harp           |
| 123 | Bird Tweet              | flute          |
| 124 | Telephone Ring          | bell           |
| 125 | Helicopter              | didgeridoo     |
| 126 | Applause                | snare          |
| 127 | Gunshot                 | basedrum       |

这张表是提案，评审时可以逐行改；改完实现时它就是唯一的映射来源。

## 5. 音高映射

### 5.1 公式

对有音高的乐器，锚点为 `A`：

```
note = midi + 12 * transpose + 12 * k - A
```

`k` 是整轨八度偏移，同一轨统一。`note` 必须落在 0–24。

### 5.2 整轨八度选择

1. 先按 5.1 试 `k = -2..2`。
2. 选「超界音符最少」的 `k`；并列时选 `|k|` 最小的。
3. 如果存在让整轨都落在 0–24 的 `k`，就用它。
4. 如果整轨跨度超过 24 个半音，没有任何 `k` 能全放下：选超界最少的，剩下的音按现有 `outOfRange` 策略逐个兜底。

这对应你选的「整轨先选一个八度偏移，个别音再兜底」。它优先保持旋律轮廓，代价是个别轨整体升降八度。

### 5.3 个别音兜底

- `warn` / `octave`：把该音移回音域（最近的整八度），`warn` 逐条报告，`octave` 只累计到 `rangeShift`。
- `clamp`：拉到 0 或 24。
- `drop`：不放置，报告。

### 5.4 本文件的逐轨结果

| 轨  | 原生乐器       | 原版模式 `k` | 原版模式实际音高        | 扩展模式乐器   | 扩展模式 `k` |
| --- | -------------- | ------------ | ----------------------- | -------------- | ------------ |
| 0   | harp           | 0            | 60–74                   | 钢琴五槽       | —            |
| 1   | flute          | +1           | 72–86                   | bit            | 0（60–74）   |
| 2   | chime          | +2           | 88–96                   | chime          | +2           |
| 3   | bit            | 0            | 72–77                   | bit            | 0            |
| 4   | pling          | −1           | 60–72                   | pling          | −1           |
| 5   | xylophone      | +1           | 84–96                   | xylophone      | +1           |
| 6   | iron_xylophone | 0            | 53 单音 +12，其余 54–72 | iron_xylophone | 同左         |
| 7   | bell           | +2           | 84–91                   | chime          | +2           |
| 8   | guitar         | −1           | 43–60                   | banjo          | 0（55–72）   |
| 9   | banjo          | 0            | 64–78，79 单音 −12      | banjo          | 同左         |
| 10  | bass           | −1           | 36–50                   | didgeridoo     | −1           |
| 11  | didgeridoo     | 0            | 36–43                   | didgeridoo     | 0            |
| 12  | basedrum       | —            | 固定                    | basedrum       | —            |
| 13  | snare          | —            | 固定                    | snare          | —            |
| 14  | hat            | —            | 固定                    | hat            | —            |
| 15  | cow_bell       | +1           | 68（G#4）               | cow_bell       | +1           |

这张表也说明为什么需要「整轨偏移」：guitar 和 bass 在原版模式下会整体降八度；如果你更希望保留多数音、只折叠少数超界音，这条规则需要改（评审点 3）。

### 5.5 打击乐

固定音高，跳过 5.2 的八度选择；`note=0`，命令后端 `pitch=1`。被丢弃的鼓音符按轨汇总成一条警告，不逐音刷屏。

## 6. 代码改动

### 6.1 新增模块

- `src/core/palette/instruments.ts`
  - `NoteBlockInstrument` 改为 16 值联合。
  - `INSTRUMENTS`：底块、锚点、音域、是否固定音高、sound event。
  - `PIANO_SLOTS`、`DRUM_INSTRUMENTS`、`instrumentRange()`。
- `src/core/palette/instrumentMap.ts`
  - `GM_INSTRUMENTS`：128 项表。
  - `instrumentFromName()`：最长匹配、中英文别名。
  - `drumInstrument()`：35/36、38/40、42/44/46。
  - `detectInstrument(track)`：返回乐器 + 来源（gm/name/drum/fallback）。
- `src/core/palette/pitchMap.ts`
  - 保留现有 `mapPitch`（五槽模式），新增 `mapPitchToInstrument(midi, instrument, policy, transpose)`。
  - `MappedPitch` 保持兼容；新函数返回带 `instrument` 和 `block` 的结构。

### 6.2 布局

- `LayoutOptions` 增加 `assignments?: Record<number, TrackAssignment>`：
  ```ts
  type TrackVoicing =
    | { kind: 'pitch' } // 五槽钢琴扩展
    | { kind: 'instrument'; instrument: NoteBlockInstrument }
    | { kind: 'drums' }; // 通道 9，按音符逐个映射
  ```
- 不传 `assignments` 时，所有轨走 `kind: 'pitch'`，合并 key 仍按旧的 MIDI 乐器名，现有测试和行为不变。
- `prepareGroups` 按 `voicing` 选择 `mapPitch`、`mapPitchToInstrument` 或 `mapDrumNote`。
- `buildTrack` 把 `voicing` 传给 `prepareGroups`；`noteBase` 的解析优先级变为：
  `track 覆盖 > 乐器底块 > 全局默认`。
- `BlockQuery` 增加 `instrument?`，`BlockDefaults` 增加按乐器的底块默认值。
- 合并 key：
  - `kind: 'pitch'` → `piano`
  - `kind: 'instrument'` → `instrument:<id>`
  - 打击乐独立分组。
- 强制合并：所有源轨合成**一条**主线；每个音按自己源轨的 `voicing`/`octaveOffset` 映射，`forcedValidation` 继续按实际方块图校验整条主线。和弦行相邻：≤27 音用普通分支列（≤3 音单跳、≥4 音每行一个同延迟中继器），超过 27 音才退回 staged 两行总线。
- `LayoutResult` 增加 `trackInstruments`，携带原生/生效乐器、识别来源、八度偏移、丢弃数。

### 6.3 命令后端

- `ScheduleOptions` 增加 `assignments`。
- `collectEvents` 按 voicing 选 `mapPitch`、`mapPitchToInstrument` 或 `mapDrumNote`。
- `sound = minecraft:block.note_block.<instrument>`；鼓 `pitch=1`，有音高乐器用 `playbackPitch(note)`。
- `NOTE_BLOCK_INSTRUMENTS` 扩到 16；`buildStopCommands(objective, used)` 只停止实际用到的音色。
- `CommandPlaybackInfo` 增加 `instruments`。

### 6.4 主进程

- `GenerateOptions` 增加 `instrumentMode?: 'native' | 'extended'`，默认 `extended`。
- `extendedRange` 保留为兼容入口：`false` → `native`，`true`/缺省 → `extended`。
- `generate()` 在解析后构建 assignments：
  - 逐轨 `detectTrack`。
  - native：全部 `kind:'instrument'`（原生）；通道 9 为 `kind:'drums'`。
  - extended：harp/未识别 → `kind:'pitch'`；bass/guitar/flute/bell → 替代；其余 → 原生；通道 9 → `kind:'drums'`。
- `TrackModel` 增加 `program?: number`（GM 音色号），由 `parseMidi` 从库的 `track.instrument.number` 填入。没有它就无法实现 GM 优先。
- `AnalyzeResult.tracks` 增加 `program`、`detectedInstrument`、`detectionSource`，供选轨页显示。
- `GenerateResult` 增加 `trackInstruments`；`pitchRange` 只在存在五槽钢琴轨时有值，否则为 `undefined`。
- CLI（`scripts/cli.ts`）只做分析，不生成；它在每轨输出里增加 `GM` 与 `识别=...`，没有 `--mode`。

### 6.5 渲染层

- 配置页：原来的「全竖琴音域 / 不扩展音域」换成「扩展竖琴音域（默认）/ 原版乐器」。
- 选轨页：每条轨显示原生识别结果，例如「识别：竖琴（GM 0）」或「识别：钟琴（轨道名）」。
- 检查页：显示生效乐器分配（原生 → 生效、替代、八度偏移、丢弃的鼓音符）。
- 结果页：警告汇总；不再显示单一 `pitchRange`。
- `blocks.js`：补齐 13 种底块的颜色和中文名（浮冰、骨块、铁块、灵魂沙、南瓜、绿宝石块、干草块、萤石、石头、沙子、玻璃等）。
- `warningText.js`：新增警告文案；`OUT_OF_RANGE` 文案使用每轨音域。
- 资源包提示：只在扩展模式、且五槽确实被使用时弹出。

### 6.6 文档与规则

- `docs/redstone-model.md`：乐器表扩到 16 种；加「MC 没有钢琴音色」说明；资源包只服务五槽。
- `README.md` / `README.en.md`：两种模式、16 种乐器、识别规则、资源包注意事项。
- `docs/status.md`：记录本次改动。
- `CHANGELOG.md`：加一条未发布记录。
- `.opencodereview/rule.json`：更新 palette 规则（16 种锚点、固定鼓、GM/名称优先级、替代表、无钢琴音色）。
- `AGENTS.md`：补一条「乐器识别/锚点」不变量和测试夹具说明。

## 7. 界面

### 7.1 配置页

- 乐器模式：
  - 扩展竖琴音域（默认）：钢琴/未识别轨用五槽扩展到 F#1–F#7；其它乐器原版；被占用的原生乐器用相近音色替代。
  - 原版乐器：每条轨用自己的乐器，各两个八度。
- 复音上限 `dMax` 不变。
- 资源包说明按模式变化。

### 7.2 选轨页

每行在音符数后加一段识别结果：

- `识别：竖琴（GM 0）`
- `识别：钟琴（轨道名）`
- `未识别，按竖琴处理`

只读，不做下拉框（评审点 7）。

### 7.3 检查页

在问题列表上方或下方加一个可折叠的「乐器分配」表：

| 轨  | 原生   | 生效       | 八度偏移 | 说明                     |
| --- | ------ | ---------- | -------- | ------------------------ |
| 8   | guitar | banjo      | 0        | 扩展模式替代             |
| 10  | bass   | didgeridoo | −1       | 扩展模式替代，整轨降八度 |

这样用户能一眼看出为什么听起来和 MIDI 不一样。

### 7.4 结果页

警告汇总加上乐器相关条目；不展示单一音域。

## 8. 警告

新增（都要进 `LayoutWarning` 联合、`WARN_TEXT`、`warningCoverage`）：

| code                        | 级别 | 含义                                     |
| --------------------------- | ---- | ---------------------------------------- |
| `INSTRUMENT_UNKNOWN`        | info | 没识别出来，按 harp 处理                 |
| `INSTRUMENT_SUBSTITUTED`    | info | 扩展模式下原生乐器被替代                 |
| `INSTRUMENT_OCTAVE_SHIFT`   | info | 整轨为了放进乐器音域做了八度偏移         |
| `INSTRUMENT_RANGE_OVERFLOW` | warn | 整轨跨度超过 24 个半音，有音需要单独兜底 |
| `DRUM_NOTES_DROPPED`        | warn | 鼓通道里有无法映射的音符，已丢弃         |

`OUT_OF_RANGE` 增加可选的 `instrument` / `low` / `high`，让文案能说清是哪个乐器的音域。

## 9. 兼容性

- 16 种经典乐器在 1.12/1.14 就已存在，1.17.1 起全部可用；不引入 trumpet，所以 1.20.4 数据版本和旧版本都安全。
- 不传 `voicing` 的布局调用保持五槽行为，现有 212 个测试不受影响。
- 默认 `extended` 对纯钢琴曲与现在等价。
- `extendedRange` 旧参数继续可用。
- 「合并同乐器」按生效乐器分组，五槽钢琴轨按 `piano` 一组；「强制合并」不再按乐器分组，全曲只留一条主线。
- 普通模式的 Z 间距按每条轨自己的和弦上下行数计算，相邻轨之间只留一格空行；不再用全曲最大和弦统一拉开。
- 资源包在老模式的语义不变；原版模式要提示不要安装。

## 10. 测试

### 10.1 夹具

- `test/fixtures/happy-birthday-16.mid`：你提供的 16 轨文件，入库。
- 另加一个代码合成的 2–3 轨小 MIDI，覆盖 GM 缺失、轨道名回退、鼓丢弃等边界，避免只靠真实文件。

### 10.2 单元

- 16 种乐器的底块/锚点/音域/固定音高。
- GM 表 128 项完整、无缺号。
- 名称别名的最长匹配（Bass Drum 不落 Bass、Iron Xylophone 不落 Xylophone、Cow Bell 不落 Bell）。
- 通道 9 映射与 Cow Bell 例外。
- 整轨八度选择：能全放下时选 `|k|` 最小；放不下时超界最少；跨度 >24 的兜底。
- `mapPitchToInstrument` 的边界、clamp、drop、transpose。
- 扩展模式替代表。

### 10.3 集成

- 解析夹具 → native / extended 两种 `voicing` → 布局：
  - 音符合法：每个音符盒的 `instrument` 与生效乐器一致，底块一致。
  - 音符守恒：除被丢弃的鼓音符外不丢音。
  - 时序不变：沿用 `layout.acceptance` 的不变量。
  - litematic 往返 + `VerifyLitematic.java` 独立校验。
- 命令后端：每轨 sound event 正确；鼓 `pitch=1`；stopsound 覆盖实际用到的音色。
- `warningCoverage`：新警告码都有文案和发射点。

### 10.4 UI

- `verify:ui` 扩到：切换两种模式、选轨页显示识别、检查页显示分配表、资源包提示只在扩展模式出现。
- 截图放 `out/ui-shots/`。

### 10.5 闸门

`lint` / `typecheck` / `test` / `build` / `format:check` / `smoke` / `verify:ui` / `verify:about` 全绿，CI Node 20/22 通过。

## 11. 实施顺序

1. 数据表 + 识别 + 单元测试（不改现有行为）。
2. `mapPitchToInstrument` + 布局 `voicing` + 集成测试（opt-in）。
3. 主进程选项 + 命令后端。
4. 界面（模式开关、识别展示、分配表、资源包提示）+ 预览颜色。
5. 夹具入库 + 验收测试 + 文档 + status。
6. 全量闸门 + 真机验证。

提交建议拆成 4–5 个 commit：`feat: instrument tables and detection`、`feat: instrument-aware layout`、`feat: instrument-aware command playback`、`feat: multi-instrument UI`、`test/docs`。

## 12. 评审记录（已确认）

按推荐值实现：bass→didgeridoo、guitar→banjo、flute→bit、bell→chime；整轨八度按「超界最少」；原版模式提示不要装包；只做只读识别 + 分配表；夹具入库。

1. **替代表**：bass→didgeridoo、guitar→banjo、flute→bit、bell→chime，是否同意？flute 也可以换 cow_bell（音域相同、音色是钟）。
2. **GM 128 表**：有没有想改的行？特别是 organ / strings / brass / pad / FX 这几段，映射比较主观。
3. **整轨八度规则**：按 5.2 的「超界最少优先」，本文件的 guitar、pling、bass 会整体降八度。如果你更想保留多数音、只折叠少数超界音，要改成「总位移最小优先」。
4. **名称别名**：有没有要补的写法（例如你常用的轨道命名）？
5. **资源包**：原版模式下提示「不要安装配套包」，可以接受吗？
6. **UI 范围**：只读识别 + 分配表，不做每轨下拉，确认？
7. **结果页**：是否需要把「乐器分配」也放到完成页，而不只是检查页？
8. **夹具文件名**：`test/fixtures/happy-birthday-16.mid`，确认可以入库。
