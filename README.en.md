# MusicboxMC

<p align="center">
  <img src="icon.png" alt="MusicboxMC" width="120" height="120" />
</p>

<p align="center">
  <strong>Turn a MIDI file into a Minecraft redstone music schematic.</strong><br />
  Import a song, press generate, paste a <code>.litematic</code>, and listen.
</p>

<p align="center">
  <a href="README.md">简体中文</a>　·　<strong>English</strong>
</p>

<p align="center">
  <a href="https://github.com/xingtuan416/MusicboxMC/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/xingtuan416/MusicboxMC?color=2ea44f"></a>
  <a href="https://github.com/xingtuan416/MusicboxMC/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/xingtuan416/MusicboxMC/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: GPL-3.0-only" src="https://img.shields.io/badge/license-GPL--3.0--only-blue"></a>
</p>

![The MusicboxMC interface](docs/images/interface.png)

MusicboxMC reads a MIDI file, compiles it into a redstone circuit, and writes that
circuit as a Litematica `.litematic` schematic. Paste it into a world, apply
redstone power at the start, and the song plays.

The hard part is not placing note blocks, it is timing. The generator quantises
every note onto the redstone tick grid, works out the repeater delays that carry
the gap between groups, and pads tracks with redstone dust — which adds no delay —
so that independent tracks stay aligned instead of drifting apart over the length
of a song.

## Download

Windows x64. Grab either file from the
[latest release](https://github.com/xingtuan416/MusicboxMC/releases/latest).

| File                                 | What it is                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `MusicboxMC-Setup-0.2.2-win-x64.exe` | Installer. Choose a directory, get Start menu and desktop shortcuts.         |
| `MusicboxMC-0.2.2-win-x64.zip`       | Portable. Unzip and run `MusicboxMC.exe`; writes nothing outside its folder. |

Supported Minecraft Java Edition versions: **1.17.1 – 26.3 (latest)**. **1.16.5 and below will not work.** You also need
[Litematica](https://masa.dy.fi/mcmods/client_mods/?mod=litematica) mod to paste
what it generates.

> **The interface is currently in Chinese.** Other locales are not implemented yet.
> The schematic it generates is language-independent.

## Quick start

1. **Import.** Open the app and pick a `.mid` or `.midi` file. It shows the tempo,
   time signature, track list and note count straight away.
2. **Adjust.** Most songs need nothing changed. The settings that matter are `dMax`
   — how wide one chord column may be — and what to do with notes outside the
   covered range.
3. **Check, then generate.** After choosing a folder the app runs the generator once
   without writing anything, lists what it found on the **check results** step, and
   draws the **redstone wiring** view: one row per Z row, one column per X cell, time
   running to the right. It is a **viewport**, not the whole drawing — drag or scroll
   to pan, at a fixed, readable cell size. When it looks right, **generate** writes
   the file.

   ![The redstone wiring view](docs/images/preview.png)

4. **Paste.** Put the `.litematic` in `.minecraft/schematics/`, load it with
   Litematica in game, and power the circuit at its start.

If anything needs attention afterwards, the **check results** step lists it. Every
warning that has a location carries a **locate in the wiring view** button: one click
opens the wiring view centred on that cell, with the cell ringed — no hunting for it
by hand.

## What it does

**Inline main line.** Repeaters and note blocks share one line instead of sitting
on separate wiring layers, so there is no redundant dust and less to mis-align. A
note block must have air directly above it to sound, which is why everything has to
share a single layer.

**Chords that fit.** Up to three notes fire from one repeater: the inline note block
lights its immediate neighbours, one hop, with no extra dust or repeaters. From four
notes up the chord switches to branch rows, each with its own repeater, so the whole
chord still fires on a single redstone tick.

**Tracks that stay together.** A sparse track and a dense one consume different
numbers of cells per beat. Left alone they drift hundreds of cells apart and the
song stops sounding like one performance. Every track follows a shared time-to-X
reference line, padded forward with dust, which never changes when a note fires.

**Merging, if you want it.** Tracks that share an instrument can be merged onto one
line. There is also a stricter mode that builds **one** connected spine for the whole
song (different instruments can share that line), audits the block graph it actually
produced — reachability, exact trigger ticks, repeater locking, support blocks — and
refuses to write a file when the result would not work.

## Two playback backends

The default backend builds a redstone circuit of note blocks. It is what the
screenshots show, and it is what you want if you are building in a world.

There is also an opt-in **command block playback** backend. It places no note
blocks, dust or repeaters at all: every note becomes a `playsound` command, run for
each player at their own position and quantised to game ticks. That removes the two
things a circuit cannot escape — you must be near it to hear it, and its polyphony
is capped by signal strength — at the cost of needing command blocks and loading the
server.

It is worth knowing that the obvious implementation does not scale. One command
block per note turns a 46,000-note song into 46,308 blocks and a 348 KB schematic,
and the chain then walks all of it every tick. This implementation stores the
schedule as a small table and replays it through a bounded number of reused
commands, which keeps the same song at 798 blocks, 764 chain steps and **27.9 KB**.

Requirements and limitations are in
[docs/command-playback.md](docs/command-playback.md); read it before planning
anything long.

## Instruments, range, and what the resource pack is for

A note block has two octaves on its own. Vanilla has **16 classic note-block
instruments** — 13 pitched and 3 fixed-pitch drums — each starting at its own F#
anchor. The full table, GM map and detection rules are in
[the multi-instrument design](docs/multi-instrument.md).

**Minecraft has no piano instrument.** Dirt and most other blocks play the **harp**
sample, which is the closest thing and is what tutorials usually call piano. This
project's "piano" is the harp sample plus the companion pack's five-slot replacement.

The interface has two modes:

- **Extended harp range** (default): piano and unidentified tracks use bass, guitar,
  harp, flute and bell to reach **F#1–F#7**; other instruments stay native; tracks
  natively using one of those five are replaced with the closest free timbre
  (bass→didgeridoo, guitar→banjo, flute→bit, bell→chime).
- **Native instruments**: every track follows its MIDI instrument across its own two
  octaves; a piano track uses harp, **F#3–F#5**.

Detection order is GM program → drum channel → track name → harp, and the track step
shows what each track was detected as.

A companion resource pack replaces the five extended-mode sound events with piano
samples, so the whole range sounds like a single piano. **It is optional**, and the
schematic is identical either way. **It is not recommended in native mode**, where it
would also replace native bass, guitar, flute and bell.

The pack **ships inside the application**. A _Save (about 50 KB)_ button sits on the
export step, and the first extended-mode export offers it once. Put the file in
`.minecraft/resourcepacks/` and enable it in game. It is also on the
[release page](https://github.com/xingtuan416/MusicboxMC/releases/latest/download/MusicboxMC-piano-pack-1.20.4.zip)
if you would rather download it directly.

`npm run resourcepack:check <pack.zip>` validates any pack against the mapping the
generator expects.

## How this compares to Note Block Studio

Different tools, and it is worth being clear about which one you want.

|                    | MusicboxMC                           | Note Block Studio                        |
| ------------------ | ------------------------------------ | ---------------------------------------- |
| Purpose            | Convert a MIDI file into a schematic | Write and edit note block music          |
| Input              | `.mid` / `.midi`                     | Its own `.nbs` project, or a MIDI import |
| Output             | `.litematic`, ready to paste         | `.nbs`, exported through other tooling   |
| Editing the result | None; change the MIDI and regenerate | A full piano-roll editor                 |
| Audio preview      | None; you check it in game           | Built in                                 |
| Maturity           | New                                  | Years of use and a large community       |

If you want to arrange, adjust individual notes, or hear it before you build it, use
Note Block Studio. If you already have a MIDI and want the circuit, this skips the
arranging step.

## Building from source

Node.js 20 or newer.

```bash
git clone https://github.com/xingtuan416/MusicboxMC.git
cd MusicboxMC
npm ci
npm test
npm start          # compiles with tsc, then launches Electron
```

Packaging a Windows build needs Windows:

```bash
npm run dist       # NSIS installer plus a portable zip, into release/
npm run dist:dir   # unpacked directory only, much faster for testing
```

The other checks are `npm run lint`, `npm run typecheck` and `npm run build`. Those
three plus `npm test` are what CI runs.

The engine under `src/core/` is pure logic with no Electron or DOM dependency, so it
runs and is tested in plain Node. That is where the layout, timing, NBT and litematic
code lives, and the part worth reading if you want to change how a circuit is built.

## Documentation

- [Architecture](docs/architecture.md) — layering, data flow, where to change what
- [The redstone model](docs/redstone-model.md) — topology, timing, alignment, and
  what is deliberately not simulated
- [Command playback](docs/command-playback.md) — the schedule, the chain, the
  budgets, and the in-game requirements
- [Litematic format](docs/litematic-format.md) — bit packing, index order, region
  rules
- [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Security](SECURITY.md)

## License

[GNU General Public License v3.0](LICENSE).
