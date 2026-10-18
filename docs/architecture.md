# Architecture

MusicboxMC turns a MIDI file into a Minecraft `.litematic` schematic that plays
redstone music. This document describes how the code is organised and where to
make a change.

## Layering

```
src/
├── core/         pure logic, no Electron and no DOM
│   ├── midi/         MIDI bytes  -> SongModel
│   ├── tempo/        seconds <-> game ticks, speed conversion table
│   ├── palette/      MIDI pitch -> note block state, block material choices
│   ├── layout/       SongModel   -> redstone circuit (placements)
│   ├── command/      SongModel   -> command-block player (alternative backend)
│   ├── nbt/          NBT tag model, big-endian reader/writer
│   └── litematic/    placements  -> .litematic bytes (region packing, gzip)
├── main/         Electron main process: file dialogs, IPC handlers, orchestration
├── preload/      contextBridge surface exposed to the renderer
└── renderer/     the GUI: plain DOM + Canvas, no framework
```

The renderer is plain ES modules with no build step: `app.js` is the entry point
and imports the rest. Electron serves it over a custom `app://` scheme rather than
`file://`, because Chromium refuses to load module scripts from a `file://` page —
the origin is opaque. Registering the scheme as standard and secure fixes that, and
keeps the renderer off the file system besides.

Dependency direction is strictly one way: `core` knows nothing about `main`,
`preload` or `renderer`. That is what makes the whole engine testable in plain
Node — see the suite under `test/`, which imports `src/core/**` directly and
never boots Electron.

## Data flow

```
file.mid
  │  core/midi/parse.ts
  ▼
SongModel                       { tracks: TrackModel[], tempos, ppq, ... }
  │
  ├─ core/layout/index.ts  ──►  LayoutResult  { tracks: TrackSkeleton[], size, min, warnings }
  │     │  core/layout/track.ts     one track: main line, chord branches, taps
  │     └─ core/layout/forced.ts    one spine per instrument (opt-in)
  │
  └─ core/command/index.ts  ──►  CommandPlaybackResult { region, info, warnings }
        (independent backend; does not go through layout/)

LayoutResult
  │  core/layout/regions.ts   split into per-track regions, translate to origin
  ▼
RegionData[]                    { position, size, blocks[], tileEntities[] }
  │  core/litematic/build.ts  palette, bit packing, NBT tree
  ▼
.litematic (gzip)
```

`src/main/service.ts` is the only orchestrator. It exposes three entry points:

| function                             | purpose                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `analyzeFile(path)`                  | parse only; used to show song metadata right after import |
| `generate(path, options)`            | full pipeline, returns the result **and** the bytes       |
| `generateToFile(path, out, options)` | the above, then write to disk                             |

Failures are returned as `success: false` plus a human-readable `error`, not
thrown, so the GUI can display them without a try/catch around every call.

## Module responsibilities

| module           | responsible for                                             | not responsible for            |
| ---------------- | ----------------------------------------------------------- | ------------------------------ |
| `core/midi`      | decoding the MIDI container, normalising notes to seconds   | quantisation, pitch mapping    |
| `core/tempo`     | the game-tick grid and the speed table                      | reading tempo events from MIDI |
| `core/palette`   | which note block state and which base block a pitch becomes | where that block goes          |
| `core/layout`    | circuit topology, timing, spatial alignment, warnings       | NBT or file formats            |
| `core/command`   | the command-block player, its schedule and its geometry     | redstone topology              |
| `core/nbt`       | the tag model and binary encoding                           | what the tags mean             |
| `core/litematic` | region packing, bit arrays, the `.litematic` schema         | circuit design                 |
| `main`           | dialogs, IPC, orchestration, writing files                  | any generation logic           |
| `renderer`       | presentation and parameter collection                       | any generation logic           |

## Where to change what

- **Note block pitch mapping or base blocks** → `core/palette/pitchMap.ts`
  (regions and instruments) and `core/palette/blockTable.ts` (material overrides).
- **Circuit topology or timing** → `core/layout/track.ts`. The file starts with a
  description of the topology and the time model; read that first.
- **The opt-in single-spine layout** → `core/layout/forced.ts`, plus
  `core/layout/forcedValidation.ts`, which audits the produced block graph and
  refuses to export when it is unsafe.
- **Command-block playback** → `core/command/` (`index.ts` orchestrates; `schedule.ts`,
  `commands.ts` and `player.ts` hold the table, the command text and the layout).
- **The `.litematic` binary format** → `core/litematic/`.
- **Anything the user sees** → `src/renderer/`.

## Design rules the code follows

1. **The generator writes block states, never world state.** A schematic is
   pasted unpowered; redstone dust is written with `power=0` and left for the
   game to propagate. Writing `power=15` would paste a pre-lit circuit.
2. **Timing is expressed in redstone ticks, not in cells.** Redstone dust adds no
   delay in this model; only repeaters do. Padding a line with dust therefore
   never changes when a note fires — see [redstone-model.md](redstone-model.md).
3. **Everything the generator emits comes from a constructor.** Block states are
   built by `core/palette/noteBlock.ts` and joined to positions by
   `core/layout/placement.ts`, so blockstate semantics have one definition.
4. **Unsafe output is refused, not warned about.** The forced layout throws before
   writing a file when its geometry cannot be built safely.
5. **Warnings are declared, emitted and translated in three places** — the union
   in `core/layout/types.ts`, the emission sites, and `WARN_TEXT` in the
   renderer. `test/warningCoverage.test.ts` fails if they drift apart.
6. **The core reports codes, not sentences.** A failure throws a `CoreError`
   (`core/errors.ts`) carrying a stable code and the values behind it;
   `main/messages.ts` owns the wording, and its exhaustive `Record` type means a
   new code without text will not compile. The engine has no opinion about what
   language the user reads.

## Related documents

- [redstone-model.md](redstone-model.md) — the circuit and its timing model
- [command-playback.md](command-playback.md) — the command-block backend
- [litematic-format.md](litematic-format.md) — the output file format
