# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Redstone dust connections now follow vanilla `RedStoneWireBlock`. Both previous
  implementations were wrong in different ways: one connected to a repeater from
  any side and to note blocks, the other connected to solid blocks. Neither
  filled in an empty axis, so an isolated dust block was written as four `none`,
  which renders as a bare dot instead of the cross the game draws.
- The lockfile was not portable. It recorded only the Windows rollup binary, so
  `npm ci` failed on Linux, which meant every CI run failed.

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

### Added

- CI: typecheck, tests and build on Node 20 and 22, for every push and pull
  request.
- ESLint, Prettier, EditorConfig and `.gitattributes`, none of which existed.
- `docs/`: architecture, the redstone timing model, the command playback
  backend, and the litematic output format.
- `test/wireConnections.test.ts`, which encodes the dust connection rules from
  Minecraft rather than from this project's output.

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

[Unreleased]: https://github.com/xingtuan416/MusicboxMC/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/xingtuan416/MusicboxMC/releases/tag/v0.1.0
