# Redstone model

How the generator turns note events into a redstone circuit, and which parts of
Minecraft's behaviour it deliberately does not model.

## Time

| unit            | value                                |
| --------------- | ------------------------------------ |
| 1 game tick     | 50 ms at 20 TPS                      |
| 1 redstone tick | 2 game ticks = 0.1 s                 |
| repeater delay  | 1–4 redstone ticks, set per repeater |

MIDI note times are converted to game ticks with `secondsToTick`, then rounded
onto the redstone-tick grid by `gameTickToRedstone`. That rounding is the only
quantisation the layout performs, so a note fires at most one game tick away
from its nominal time.

**Redstone dust contributes no delay.** Only repeaters do. This is the single
most important property of the model: it means a line can be padded with dust to
make a track travel further in space without changing when anything fires. Every
spatial-alignment correction in `core/layout/track.ts` relies on it.

## Signal strength

Dust carries power 15 at the source and loses one per cell. A repeater needs an
input of at least 1, so a branch may extend at most **14 rows** away from the
column that powers it (`MAX_SIDE_ROWS`). That is a physical limit, not a
tunable, and it is what caps a single chord column at

```
chordCapacity(dMax) = 2 * min(14, dMax) + 1
```

with `dMax` letting the user ask for something smaller. A group that exceeds the
capacity is not silently truncated: the surplus is registered as overflow and
re-emitted on a new lane, reported as a `TRACK_SPLIT` warning.

## Topology

The main line runs along +X and carries the delay chain:

```
... [N] [branch column W] [R(r)] [N] [branch column W] [R(r)] [N] ...   →  +X
        └─ only for chords of 4 or more notes
```

- `[N]` note block, inline on the main line
- `[R(r)]` repeater with delay `r`, always facing west so its output points east
- `[W]` redstone dust

Each group of notes that fires on the same redstone tick gets one column. The
first note of the group sits inline on the main line; the rest are placed on
rows extending along ±Z.

### Chords of up to three notes: single-hop conduction

A note block powers its immediate neighbours, and only one hop. A repeater
powering the inline note block therefore also lights the note blocks one row to
either side — enough for a three-note chord, with no dust and no repeater on
those rows at all. This is why a small chord costs two cells instead of three.

The hop limit is also why the trick stops at three: in a row `[a][b][c][d]`,
powering `b` lights `a` and `c` but not `d`.

### Chords of four or more notes: branch mode

Beyond three notes the branch column has to be laid with dust, because the outer
rows are too far for a single hop. Dust in a column is one connected network, so
every row in the column is powered at the same instant; each extra note then gets
its own row with its own repeater, set to the same delay as the main line's
final repeater. All notes in the group therefore fire on the same redstone tick.

## Timing

For a group arriving at redstone tick `rt`, with `prevRt` the previous group:

```
gap        = rt + base - prevRt
r          = min(4, gap)            last-stage repeater delay
rest       = gap - r                carried by repeaters ahead of the group
restCells  = ceil(rest / 4)
```

`base` is a song-wide lead-in of 0 or 1 redstone tick. A repeater cannot have
delay 0, so a group landing on redstone tick 0 cannot fire earlier than one
redstone tick in. That offset has to be identical on every track or the tracks
would drift apart relative to each other, so `layout()` computes it once for the
whole song and passes it down.

`TIMING_ADJUSTED` is reported when a note's actual firing tick differs from its
quantised tick by more than the grid rounding plus the lead-in.

## Spatial alignment

Independent tracks would naturally drift apart in X over a long song: a dense
track consumes more cells per beat than a sparse one, so by the end of the piece
they are hundreds of cells apart and no longer sound like one performance.

`layout()` avoids this by building a shared **time → X reference line**: the
upper envelope of every track's natural X at each redstone tick. Because it is an
upper envelope, it is never behind any track, so a track only ever has to _pad
forward_ with dust — never compress, never re-time, never cross-connect.

- At ticks where two or more independent tracks land a note, the tolerance is 0:
  they are aligned exactly.
- Elsewhere the tolerance is `ALIGN_TOLERANCE_CELLS` (12 cells), so a track is
  only padded when it has fallen meaningfully behind.
- A single padding run is capped at `MAX_PAD_RUN` (13 cells) between repeaters.
- If the deficit cannot be closed, the residual is reported as `SPATIAL_DRIFT`.
  The timing is never changed to make the geometry work.

## Pitch, and the note-block palette

One note block covers two octaves: its `note` property runs 0 to 24, two semitone
steps per value, above the pitch its base block sounds at. A single instrument
therefore cannot hold a piano piece.

Between them, the five note-block instruments reach **F#1 to F#7** (MIDI 30 to 102),
because each starts at its own F# anchor:

| Slot | Base block | Instrument | Starts at     |
| ---- | ---------- | ---------- | ------------- |
| A    | oak planks | bass       | F#1 (MIDI 30) |
| B    | white wool | guitar     | F#2 (MIDI 42) |
| C    | dirt       | harp       | F#3 (MIDI 54) |
| D    | clay       | flute      | F#4 (MIDI 66) |
| E    | gold block | bell       | F#5 (MIDI 78) |

The slots overlap, so most pitches are reachable from two of them. `mapPitch` picks
the one whose note value is closest to 12, because 12 is the pitch each sample was
recorded at and every step away from it is a pitch shift. On a tie the higher slot
wins, so a boundary connects upward and a scale does not hop between instruments
mid-run.

**All five are vanilla instruments.** A generated schematic plays correctly with no
resource pack at all; the five octave bands simply sound different from one another.
The companion resource pack replaces those five sound events with piano samples so
the whole span sounds like one piano. It changes no block and no timing — the same
schematic comes out either way.

The **full range** switch in the interface decides which slots the generator may use:

- **On (the default)** — all five slots, covering F#1–F#7.
- **Off** — the harp slot alone, covering F#3–F#5. No resource pack is ever needed,
  at the cost of everything outside those two octaves.

Pitches outside the selected span go through the out-of-range policy — `warn`,
`octave`, `clamp` or `drop` — and are reported as `OUT_OF_RANGE` warnings. Neither
mode drops a note silently.

## What this model does not cover

The layout is a **static description**, not a simulator. The following are not
modelled and must be verified in game:

- Minecraft's block-update order and redstone tick ordering
- network isolation between adjacent groups (a group's wiring must not leak into
  its neighbour's)
- chunk loading, and whether the whole structure is loaded when it runs
- server performance and `maxCommandChainLength`

`test/layout.acceptance.test.ts` deliberately asserts only invariants that hold
regardless of those unknowns: note conservation, non-overlap between tracks, a
valid `.litematic`, and the relative timing of `placed` events. It does not
simulate redstone propagation, because a simplified propagation model would give
false confidence rather than real coverage.

The forced layout is the exception: `core/layout/forcedValidation.ts` does walk
the produced block graph, checking reachability, exact trigger ticks, repeater
locking and support blocks, and refuses to export when the geometry is unsafe.
That is a rising-edge graph check, not a full game simulation, and it says so in
its own documentation.

## See also

- [architecture.md](architecture.md) — where this code lives
- [command-playback.md](command-playback.md) — the backend that skips redstone
