# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.5] - 2026-11-19

Every card on the configuration screen now explains itself or steps out of the way: the lead-track
card is a ranked list that asks for the loudest, most prominent track, a one-track song hides the five
switches that cannot change it, and a command-block layout hides the five it cannot use instead of
greying them out. Repeaters are spread evenly through the padding, so the wire no longer looks broken
between them, and the wiring view finally follows the pointer because it is drawn from cached tiles
with a fractional offset instead of being repainted whole on every frame.

### Added

- A preferences file next to the app data (`userData/preferences.json`, `src/main/preferences.ts`) that
  remembers the last output directory and whether the resource-pack reminder was muted. It is a plain
  JSON document read and written by the main process through `prefs:get` / `prefs:set`, because the
  output directory has to be validated and granted in the main process anyway; local storage in the
  renderer cannot do that, and an unreadable file falls back to defaults instead of failing to start.
- The output directory dialog opens at the last chosen directory, and saving the pack or the schematic
  updates it, so a second export no longer starts from the default folder
  (`src/main/index.ts`, `src/preload/index.ts`).

### Changed

- The tempo readout is a whole number. It comes from `60000000 / microsecondsPerBeat`, so an exact
  70 BPM file showed `70.0003150014175` and the digits read like a defect
  (`src/renderer/app.js`).
- The import card says 选择导入 MIDI 文件 and keeps what a MIDI file is, why an audio-to-MIDI conversion
  makes a redstone-unfriendly score, and which formats are accepted behind a question-mark popover
  instead of printing them as body text (`src/renderer/index.html`, `src/renderer/app.js`).
- The import subtitle states the fact a reader wants ("校验通过 · 3 条音轨") instead of the fixed
  "MThd 校验通过 · 标准多轨序列", which also claimed a multi-track file for a single-track one
  (`src/renderer/app.js`).
- A failed import explains itself in plain Chinese and guesses at the cause (not a MIDI file, cut off
  download, no permission); the library's own wording sits behind a collapsed 技术细节 summary
  (`src/renderer/app.js`).
- The lead-track card is now a ranked list, not a dropdown: tracks are ordered by mean velocity, each
  row reads 音轨 N：乐器 · 名字, percussion is dimmed but still selectable and tagged
  打击乐 · 通常不是主音轨, and the velocity percentage is gone. The card says 主音轨 · 站在哪一条上 and
  asks for the loudest, most prominent track (the piano, not its accompaniment)
  (`src/renderer/index.html`, `src/renderer/app.js`).
- Single-track songs no longer show the lead-track card, 按主轨排序, 稀疏音轨借道 or 相邻轨道取电: none
  of them can change a one-track layout, and offering them only invites a wrong turn
  (`src/renderer/app.js`).
- A command-block layout hides the five switches it cannot use (ordering, sharing, riding, lane signs,
  instrument merge) instead of greying them out, because a disabled pill still reads as switched on
  (`src/renderer/app.js`).
- Padding is spread evenly between the repeaters of a track. The cell count is unchanged, so no note
  moves in time or space, but an old run of 300 cells put thirteen dust cells before every repeater and
  then left hundreds of bare repeaters in a row, which in game looks like the wire broke between them
  (`src/core/layout/track.ts`).
- The lane signs and the smart-selection readout give the standing spot's X as the mean X of every note
  block instead of the first cell of the circuit: a player follows the music along X, so "stand at the
  start" pointed thousands of cells away from most of the song (`src/main/generate.ts`,
  `src/core/layout/annotation.ts`).
- The resource-pack card only appears when a pack is recommended, and the reminder fires on every
  generation that needs one until 以后不再提醒 is ticked; the tick lives in the preferences file and the
  settings dialog can turn the reminder back on (`src/renderer/resourcepack.js`,
  `src/renderer/app.js`).
- The wiring view draws its blocks into cached tiles and composites them with a fractional
  offset, instead of repainting every visible block on every frame. Tiles are anchored to the cell grid
  rather than to the viewport, so panning only builds the tiles scrolling in
  (`src/renderer/preview.js`, `src/renderer/previewGeometry.js`).
- Repeaters and note blocks are lifted by a one-pixel lip instead of a per-block shadow blur, which was
  the most expensive call in the drawing pass and would bleed past a tile edge (`src/renderer/preview.js`).
- The wheel accumulates its deltas and redraws once per frame, the way a drag already did, instead of
  queueing a full redraw for every wheel event (`src/renderer/app.js`).

### Fixed

- Dragging the wiring view follows the pointer. The view offset was rounded to whole cells on each axis,
  so a drag shorter than half a cell moved nothing and a longer one jumped a cell, and because the two
  axes rounded independently a diagonal drag looked locked to one of them
  (`src/renderer/previewGeometry.js`).
- The legend and the readouts are rewritten only when the song changes, not on every frame of a pan
  (`src/renderer/preview.js`).
- The MIDI help popover floats over the import card instead of pushing its own text around: it was an
  in-flow child of a centred flex column with a translucent background, so the hint behind it showed
  through and the heading above it moved when it opened (`src/renderer/index.html`).
- A one-track file no longer shows the lead-track card, 按主轨排序, 稀疏音轨借道, 相邻轨道取电 or the
  merge choice: the rules only ran when a switch changed, never right after the import finished, so a
  re-imported single-track file kept every card (`src/renderer/app.js`).
- The collapsed 其它 summary only reports the merge mode. It used to concatenate every switch, the
  annotation note, the author and the TPS into one run-on line, which said nothing the switch rows do
  not already say (`src/renderer/app.js`, `src/renderer/index.html`).
- The settings dialog keeps its 打开 button inside the panel. The repository URL could not shrink, so on
  a narrower window the row pushed the button past the edge (`src/renderer/index.html`).

## [0.4.0] - 2026-11-18

This release makes a layout something a player can stand in. Listening distance is now measured from
the row the player stands on, the loudest track owns that row, and the other tracks fan out in
priority order, so importance and distance agree. Every switch that changes the schematic says what it
does and what it does not apply to, and smart selection became a preset that cannot disagree with the
file. The projection partition was rebuilt after a pasted schematic lost most of a power corridor.

### Added

- Lead-track detection from MIDI velocity alone, and lane ordering that follows it. Every song now
  gets a lead track (percussion included; ties go to the track with more notes, then to file order),
  the loudest track sits on the row the player stands on, and the other tracks alternate above and
  below it by priority, so distance from the player matches importance
  (`src/core/arrangement/prominence.ts`, `src/core/layout/index.ts`).
- Listening distance is measured from that row instead of from the whole layout: `LayoutResult.playerZ`
  is the lead track's wire row (the spine row after a forced merge) and `hearingRadius` is the distance
  from it to the furthest note block (`src/core/layout/hearing.ts`). Every 30/48 comparison, every
  warning and every readout uses the radius, so a song may span 82 cells and still fit: 27 tracks of
  鸟之诗 span 82 cells but their furthest note is 42 cells from the player.
- Configuration switches for the parts that change the schematic: 按主轨排序 (priority order or file
  order, with the player on the lead row either way), 稀疏音轨借道, 相邻轨道取电 and 投影注释. Each
  switch explains itself in place, shows what it does not apply to, and the summary line names the
  choice (`src/renderer/index.html`, `src/renderer/app.js`).
- Smart selection as an option preset: `song:plan` measures the candidate layouts without writing a
  file, picks instrument mode, merge mode and resource-pack advice, and writes them into the same
  state the manual controls use, so the switch never claims a value the file does not follow.
  `test/smartEquivalence.test.ts` pins the meaning: for twelve combinations of song shape, dMax and
  sharing, turning smart selection on produces the same regions, blocks and ticks as picking its
  answer by hand, and a thirteenth case compares the measurement step.
- Sparse-lane sharing: a track with fewer than 50 notes can be folded onto a neighbouring track
  instead of paying for its own strip of Z (threshold editable). Two or more near-empty tracks that no
  host can take are combined onto a collector track only when together they carry enough notes. The
  check step and the assignment table name every borrow, and `ShareOutcome` reports why sharing did
  or did not apply.
- Sparse-lane sharing also runs after a same-instrument merge: the merge decides how instruments
  collapse, then every track it left nearly empty is folded onto a neighbour that already has notes,
  and no collector track is created there (that would mix back the instruments the merge just
  separated). On a 27-track song the merged layout goes from 7 tracks to 6 and its hearing radius
  from 49 to 45 cells; on the 16-track fixture 12 tracks become 3.
- Lane riding (`GenerateOptions.laneRide`, default on): a track whose first note is far away no
  longer pays for its own head - the thousands of cells of repeater chain between X = 0 and the first
  note. It reads one signal from a track above and starts there. A repeater reads only its own input
  side and repeats at full strength, so one repeater per crossed row carries the reading down without
  lighting the rows it passes, and each of those rows costs one redstone tick that the layout subtracts
  again. On a 27-track song (2678 × 2 × 82, 7410 notes) that removes 30546 blocks without moving a
  single note off its tick.
- Lane signs in the schematic (`GenerateOptions.annotateLanes`, 投影注释 switch, on by default): a wall
  sign stands three blocks west of every track on a gold (lead) or copper (secondary) block, naming its
  source tracks, its strength and where to stand. The signs are a region of their own, so they can be
  deleted or moved in Litematica without touching the circuit, and the export reports the standing
  position (`LaneAnnotationInfo`) so the check step can repeat it. A forced single spine stops claiming
  a lead track: the sign reads 全曲主线 / 主线行.
- A redstone simulator (`src/core/sim/redstone.ts`) ported from the vanilla sources of redstone wire,
  repeaters and note blocks, plus tests that run real generated layouts through it: every note block
  fires on the tick the layout planned (346/346 on the 16-track fixture, 7410/7410 on a 27-track song),
  including chords that share a tick. It also models chunk loading, which is what makes a wide song
  stop playing in the middle: standing at the start of a 168-chunk song plays 4% of its notes.
- Developer mode: an opt-in diagnostics drawer (remembered per profile) with the current state, the
  smart-routing measurement, per-track prominence numbers, the last generation result, and every IPC
  call with its duration. It can re-run the measurement and the check step, copy the current view and
  save the report as JSON. With it on, the configuration step also shows a live layout readout for the
  current options, re-measured (debounced) whenever an option changes.
- Generation and the live readout share one planning function, so the hearing radius, track count and
  merge mode shown before generating are the ones the file will use, together with `ShareOutcome`, the
  number of tracks that borrow power and every measured candidate.

### Fixed

- Regions could claim the same coordinate twice. A lane's power corridor runs through the Z rows
  between its host and its guest, so a tall lane (one with deep chords) had a bounding box that
  swallowed the corridor column: that lane stored `air` where the corridor's own region stored a
  `repeater`, and whichever claim a reader honoured, the other was dropped. A pasted projection
  showed 7 of 9 corridor repeaters missing on one lane. Regions are now sliced into bands that stop
  at any column owned by another track, and a track keeps a single region whenever its box is
  already clean, so ordinary songs still ship one region per track (`src/core/layout/regions.ts`,
  `test/regionSlices.test.ts`).
- Listening distance was compared against the whole Z span instead of the distance from the row the
  player stands on, so warnings fired on songs that fit and merges were chosen for the wrong reason: a
  wide 27-track layout reported `SMART_HEARING_UNREACHED` although its furthest note was well inside
  48 cells. The check step, the router and the sharing decisions all read the radius now
  (`SMART_RADIUS.compact` / `.audible`), and the warning reads "最远 N 格".
- Re-ordering the tracks for the lead track moved every note block twice, because the block cell and
  the note it belongs to shared one object and both were translated. The note blocks ended up rows
  away from the dust that should power them: the 16-track fixture went from 40 to 56 cells wide and
  the simulator fired none of its 346 notes. Geometry is now independent of the track order (40 cells
  either way), and a regression test drives an ordered layout through the simulator note by note.
- Turning the lead track off used to leave the schematic with no lead track, no ordering and a sign
  that said 未指定主轨; the player also had to guess a Z. The lead track is always chosen now, and the
  player is always placed on its wire row - the same row the signs name.
- Track centring could widen a layout and the router measured a second, uncentred layout to warn about
  it (`SMART_CENTER_UNREACHED`). The widening was the aliasing bug above; once fixed, centring does not
  change the width, and symmetric placement makes "turn centring off to save listening distance"
  impossible to follow, so both the warning and its extra measurement pass are gone.
- The interface called MC output tracks 赛道 while 音轨 already meant MIDI tracks, so one word covered
  both ends of the pipeline. All interface text now says 轨道 for the laid-out track and keeps 音轨 for
  the MIDI one.
- Under a same-instrument merge the sharing hint claimed the whole song had been merged into one line,
  and the readout said sharing had not applied "because the song was merged into one line", while the
  file really had eight tracks. The reason now comes from the layout that was kept: `merged` only means
  a forced single spine, and `no-sparse` means the merge left no near-empty track to fold.
- Lane riding stopped working as soon as same-instrument merging was on: the tap only looked for a host
  exactly two rows away, and a merged track carries a row of chord branches on each side, so every
  neighbour was three to five rows off. A tap now crosses every row in between. 27-track song: 100956
  to 70410 blocks unmerged, 54040 to 49174 merged, and the simulator still fires all 7410 notes on
  their planned tick in both.
- A hand-made layout wider than the 48-cell hearing radius said nothing at all: the width check only
  ran on the smart path. It now reports `SMART_HEARING_UNREACHED` on both paths, with
  `attempted: false` so the wording does not claim a merge was tried.
- After any merge the lead track was still described as its own track, and nothing in the pasted
  schematic said which row to stand on: the lead track is now looked up through the tracks' source
  tracks, and a forced single spine stops claiming one.
- Smart selection was a checkbox that could read "on" while the summaries and the file followed a
  manual value. It is now an action: applying it writes the recommended options into the same state the
  manual controls use, and any manual edit shows a 手动 badge.
- A merge candidate that failed to build no longer leaves the summary claiming it was applied; the
  reported mode is the layout actually used, and `SMART_MERGE_FAILED` names the candidate that was
  dropped.
- A 30-48 cell multi-instrument song is no longer merged into a layout outside the audible radius, and
  same-instrument merging is not assumed to be narrower: every candidate is measured and accepted only
  when it removes tracks and does not push the hearing radius past 48.
- A pure-harp or single-instrument song that is too wide now says that no merge was attempted, instead
  of implying the narrowest candidate won.
- Command playback no longer reports a hearing radius, merge mode or resource-pack advice it does not
  use, and the sharing and riding cards disappear from the configuration step under a forced single
  spine instead of showing a hint that they do not apply.
- The developer layout readout measured a layout the file would never have: it skipped smart routing,
  so with smart selection on and a manual merge it could print a value the generator never produces.
- Extended harp range is only chosen for a pure-harp song whose notes do not fit the single harp slot,
  and it always comes with the pack recommendation: the five slots only sound like one instrument with
  that pack, so choosing the mode without it is a bad experience. Every other song stays on its own
  instruments and is not offered the pack.
- Same-instrument merging fitted a single octave to the union of every track it merged, which could
  shift notes that were fine on their own. Each source track now keeps the octave it would have been
  generated in alone.
- Fold-card borders are an ink hairline instead of white, which rendered as a broken dashed line at
  100% DPI, and the summary values are no longer accent-coloured.
- Starting the app a second time - or next to any other unpackaged Electron app - made Chromium print
  `Unable to move the cache: access denied (0x5)` on every launch, and two windows silently overwrote
  each other's local storage. The development build now keeps its profile in
  `%APPDATA%\MusicboxMC-dev` instead of sharing `%APPDATA%\Electron`, a second launch focuses the
  window that is already open, and the scripted runs (`smoke`, `verify:about`) ask for a throw-away
  profile (`MUSICBOXMC_USER_DATA`) so they never fight a window the developer has open.

### Changed

- Development moves to Node 26 LTS, with CI and the Windows packaging jobs on the same runtime.
  `@types/node` follows the runtime at 26.6.6.
- The outer UI has a shared smart-panel treatment, focus-visible outlines, restrained step/hover
  motion and reduced-motion support. The redstone grid itself is not animated.
- Documentation gained two code-free guides: `docs/logic-guide.md` (how every feature works) and
  `docs/constants.md` (every constant, labelled as game fact, repository convention, implementation
  choice or external assumption, with the file that uses it).

## [0.3.0] - 2026-11-14

### Changed

- The development runtime is now Node 24, with Electron 45, electron-builder
  26.18, Vitest 5, Vite 8 and TypeScript 7.0.2. TypeScript 7 ships without the API
  ESLint needs, so `typescript` remains aliased to `@typescript/typescript6` for
  `typescript-eslint`, while `typescript7` supplies the compiler used by build and
  typecheck.
- CI now runs a Windows job (`check` + `dist:dir`, and full packaging on tags/manual
  runs), the independent Java litematic reader, and Dependabot for grouped updates.
- The preview keeps a per-result cell-count cache and only reallocates the canvas when
  its size actually changes, reducing work during long-song drags.
- README describes compatibility as Litematica litematic v6 plus DataFixer support,
  rather than treating the Minecraft version list as a standalone guarantee.

### Fixed

- A single track with roughly 125,000 notes or more could overflow the call stack
  during import analysis and layout. Whole-track scans now use one loop, and the
  remaining variadic warning/merge pushes were removed as well.
- Schematic output no longer accepts a renderer-supplied absolute path. The main
  process grants an opaque directory token, the renderer supplies only a plain file
  name, and block overrides are whitelisted by slot, region and namespaced block id.
- `SPATIAL_DRIFT` now carries the source track and cell, so the warning can be located
  in the wiring preview.
- An uncaught main-process exception now reports the failure and exits instead of
  continuing with unknown state.
- The About screen reports `GPL-3.0-only`, the Issue/PR templates match the current
  workflow, and the packaged-manifest comment no longer contradicts the package.

## [0.2.5] - 2026-11-14

### Fixed

- Multi-track spatial alignment discarded the dust added to earlier groups when it
  built the shared time-to-X line. A sparse track that was padded and later became the
  naturally leading track could therefore run ahead without any `SPATIAL_DRIFT`
  warning, and simultaneous notes drifted apart in long, ordinary multi-track songs.
  The line now advances from each track's actual padded position using the same dust
  budget as the circuit. On a 27-track user song the largest simultaneous X gap fell
  from 179 cells to 5, while every repeater delay and trigger tick stayed unchanged.

## [0.2.4] - 2026-10-20

### Fixed

- `shell:open` allowed any existing local path from the renderer and handed it to
  the system handler. It now only opens existing `.litematic` files.
- `song:generate` trusted the renderer's options object. A bad `instrumentMode`
  silently fell through to extended mode, and malformed arrays could fail deep in
  the layout. The option surface is now sanitised at the IPC boundary.
- `INSTRUMENT_OCTAVE_SHIFT` reported the net of the automatic octave fit and the
  user's transpose. It now reports only the automatic fit, matching its wording.
- The external-link allowlist used `startsWith`, so `/xingtuan416/MusicboxMCevil`
  passed. It now requires an exact path or a `/` boundary.
- Dragging a replacement file while a song was loaded highlighted the hidden empty
  box instead of the visible step. The step itself now highlights, and `verify:ui`
  covers both drag-drop and click-to-choose.

### Changed

- README download tables use `<version>` placeholders instead of pinning 0.2.3,
  so a release no longer requires a manual README edit.
- CONTRIBUTING distinguishes `verify:ui` / `verify:about` (system Chromium) from
  `smoke` (built Electron, no browser).

## [0.2.3] - 2026-10-19

### Fixed

- Step 2 could not accept a dropped MIDI file. Electron 32 removed `File.path`, so the
  renderer had no way to turn the dropped `File` into a path and only the click dialog
  worked. The preload already exposed `pathForFile`; the missing piece was the drop
  handler. The whole step is now a drop target, rejects non-MIDI files with a visible
  message, highlights while dragging, and prevents Chromium from navigating away when a
  file is dropped outside it.
- The About repository link accepted any `http(s)` URL from the renderer and handed it
  to `shell.openExternal`. It is now allowlisted to this repository on GitHub; other
  hosts, other repositories and plain `http` are ignored.
- Excluded tracks still appeared in command-backend assignment warnings and the
  assignment table, and could keep a piano span alive after the last piano track was
  excluded. Both backends now derive warnings, summaries and `pitchRange` from the
  filtered assignment list.
- The whole-track octave fit ignored the per-track transpose, so a transposed track could
  choose a suboptimal offset and report a net shift that did not match what was played.
  The fit now includes the transpose, and the warning and assignment table report the
  net octave shift.
- The command backend used `Math.max(...midis)` on the whole track, which can exceed the
  engine argument limit on the long songs this project supports. It now scans once with
  a loop; the per-track range fields are also built once instead of per note.

### Changed

- `npm run check` is the single local/CI gate: format check, lint, typecheck, tests and
  build. CI now runs that command, and `docs/README.md` is the documentation index.
- The GitHub About text is Chinese and the repository has a curated 19-topic set that
  describes the current instrument, redstone and desktop-app scope.

## [0.2.2] - 2026-10-18

### Fixed

- The step 4 "Other" fold summary stayed at its initial text when the merge mode,
  author or base TPS changed, so the small line under the fold title was stale.
- Track Z spacing followed the widest chord in the whole song, so two one-row tracks
  could sit six cells apart and the far track fell outside the 48-block hearing
  radius. Each lane now reserves its own chord rows plus one empty row.
- Force merge built one spine **per instrument**, so a 16-track song still produced
  12 spines and looked like scattered bands. It now builds one connected spine for
  the whole song, with every note keeping its own instrument and octave offset.
- Chord rows in the forced layout were two rows apart, doubling a fan-out's height
  for no benefit: Minecraft does not retrigger a note block that is also lit by its
  neighbour. Rows are now adjacent; three notes use only the inline note's repeater,
  four or more give every row one repeater at the same delay, and only the staged
  fallback beyond 27 notes keeps two-row spacing.
- The preview opened at Z 0, which in a tall fan-out showed empty upper branches
  while the main line sat below the fold. It now opens on the row with the most notes.
- Redstone dust connections now follow vanilla `RedStoneWireBlock`. Both previous
  implementations were wrong in different ways: one connected to a repeater from
  any side and to note blocks, the other connected to solid blocks. Neither
  filled in an empty axis, so an isolated dust block was written as four `none`,
  which renders as a bare dot instead of the cross the game draws.
- The lockfile was not portable. It recorded only the Windows rollup binary, so
  `npm ci` failed on Linux, which meant every CI run failed.
- The interface called F#1-F#7 the resource pack's range and implied the pack was
  required. It is not: that range comes from five vanilla note-block instruments, and
  the pack only replaces their sound events so the whole span sounds like one piano.

### Changed

- `src/renderer/app.js`, a single 1332-line file, is now thirteen ES modules.
  Because Chromium refuses to load module scripts from `file://`, the main
  process serves the renderer over a custom `app://` scheme instead, which also
  keeps it off the file system.
- The core no longer throws Chinese sentences. Failures carry a stable code
  (`src/core/errors.ts`) and `src/main/messages.ts` owns the wording, so the
  engine carries no user-facing copy.
- Split `core/command`, `core/layout/track`, and `main/service` into focused
  modules; the largest source file went from 1332 to 545 lines.
- Removed dead configuration and types: `config.default.jsonc` (never read, and
  its contents contradicted the code), five unused `LayoutConfig` fields, two
  warning codes that were never emitted, and a vestigial `Segment` layer.
- All source and test comments are English. The interface itself is still
  Chinese; localising it is not done yet.
- The verification scripts now live in the repository instead of a local `out/`
  directory, `npm run lint` covers their CommonJS files, and CI runs lint
  alongside typecheck, test and build.
- Documentation was aligned with the eight-step interface: removed the obsolete
  zoom controls and "Needs attention" tab, corrected the renderer and command
  backend paths, and fixed the broken CONTRIBUTING section.
- Removed unused preview zoom/fit entry points, the unused `chooseOutput` bridge
  channel, the dead "resource pack required" block, and several dead DOM helpers.

### Added

- CI: typecheck, tests and build on Node 20 and 22, for every push and pull
  request.
- ESLint, Prettier, EditorConfig and `.gitattributes`, none of which existed.
- `docs/`: architecture, the redstone timing model, the command playback
  backend, and the litematic output format.
- `test/wireConnections.test.ts`, which encodes the dust connection rules from
  Minecraft rather than from this project's output.
- `test/fixtures/VerifyLitematic.java`, an independent litematic reader used as the
  authority for the region structure and bit packing instead of this project's own
  round-trip.
- `npm run verify:ui`, `npm run verify:about` and `npm run smoke`: real Chromium and
  Electron checks for the eight-step interface, the About section and the actual
  preload/IPC path.
- Multi-instrument support: all sixteen classic note-block instruments (thirteen
  pitched plus basedrum, snare and hat), detected from the General MIDI program,
  the channel-9 drum note, or the track name, in that order. Two modes replace the
  old full-range switch: **native instruments**, and the default **extended harp
  range**, which keeps the five-slot F#1-F#7 piano extension while the other
  instruments stay native; native bass, guitar, flute and bell tracks are replaced
  with didgeridoo, banjo, bit and chime. Whole tracks are moved by one octave to fit
  their instrument before individual notes are shifted, and the command backend now
  emits the matching sound event for every instrument.
- A sixteen-track regression fixture, `test/fixtures/happy-birthday-16.mid`, with
  one track per instrument including a cow bell on channel 9.
- The interface now exposes both instrument modes, shows the detected instrument on
  the track step, and lists the effective instrument, substitution and octave shift
  on the check and result steps.
- The companion resource pack now ships inside the application. It is offered by a
  button on the export step, and once on the first extended-mode export, so it no
  longer has to be found online.

## [0.1.0] - 2026-10-11

First release. Windows x64, Electron 33.

### Added

- Redstone note-block backend: inline main line, single-hop conduction for chords
  of up to three notes, branch rows beyond that, and multi-track spatial
  alignment so tracks do not drift apart over a long song.
- Full-range support for the 88-key piano resource pack, covering F#1 to F#7.
- Optional merging of tracks that share an instrument, including a forced mode
  that builds one connected spine per instrument and validates the produced
  block graph before writing anything.
- Optional command-block playback backend: every note becomes a `playsound`
  command, with a frame table and reusable per-voice slots so the structure stays
  proportional to the music rather than to the note count.
- Pure TypeScript NBT codec and Litematica bit packing; output is a Java 1.20.4
  `.litematic` that Litematica loads directly.

[Unreleased]: https://github.com/xingtuan416/MusicboxMC/compare/v0.4.5...HEAD
[0.4.5]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.4.5
[0.4.0]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.4.0
[0.3.0]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.3.0
[0.2.5]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.5
[0.2.4]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.4
[0.2.3]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.3
[0.2.2]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.2
[0.1.0]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.1.0
