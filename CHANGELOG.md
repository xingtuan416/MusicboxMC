# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/xingtuan416/MusicboxMC/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.2.2
[0.1.0]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.1.0
