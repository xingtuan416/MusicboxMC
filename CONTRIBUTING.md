# Contributing

Thanks for wanting to help. This document tries to say the things that are not
obvious from the code.

## Getting set up

You need **Node.js 20 or newer**. There is no build step for the renderer and no
bundler anywhere, so `npm ci` and `npm test` are all it takes to get going.

```bash
git clone https://github.com/xingtuan416/MusicboxMC.git
cd MusicboxMC
npm ci
npm test
```

To run the app itself:

```bash
npm start          # compiles with tsc, then launches Electron
```

Packaging a Windows build needs Windows, or at least an environment where
`electron-builder` can produce a Windows target:

```bash
npm run dist       # NSIS installer plus a portable zip, into release/
npm run dist:dir   # unpacked directory only, much faster
```

## Before you open a pull request

Run the same four checks CI runs:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run format` applies Prettier. Everything is already formatted, so it should
be a no-op unless you added something.

## How the code is organised

`docs/architecture.md` explains the layering and where to make a change; start
there. The short version:

- `src/core/` is pure logic. It never imports Electron, the DOM, or anything
  from `main`/`preload`/`renderer`. That is what makes it testable in plain Node.
- `src/main/` owns file dialogs, IPC and orchestration.
- `src/renderer/` is the GUI: plain ES modules, no framework.

## Conventions worth knowing

These are enforced by tests or by the compiler, so it is easier to follow them
than to fight them.

**Warnings line up in three places.** A `LayoutWarning` code is declared in
`core/layout/types.ts`, emitted from somewhere under `src/`, and given text in
`renderer/warnings.js`. `test/warningCoverage.test.ts` fails if any of the three
disagrees, because this went wrong before: two codes were declared and
translated but never emitted, so the interface promised a diagnostic the
generator could not produce.

**The core raises codes, not sentences.** Throw a `CoreError` from
`core/errors.ts` with a code and the values behind it. `main/messages.ts` holds
the user-facing text, and its exhaustive `Record` type means adding a code
without adding text will not compile. Do not put user-facing copy in `core/`.

**Block states come from constructors.** Do not hand-write a `note_block` or
`repeater` property map; use `core/palette/noteBlock.ts`. It is the one place
that knows the repeater facing convention and which properties a pasted block
needs.

**Unsafe output is refused, not warned about.** If the forced layout cannot
produce a circuit that will actually work, it throws before writing a file. Keep
it that way.

## Tests

Add a test for behaviour, not for implementation. Two patterns are worth
copying:

- `test/wireConnections.test.ts` encodes the rules from Minecraft's own
  `RedStoneWireBlock` rather than this project's output, so it fails if the
  implementation drifts from the game.
- `test/helpers/song.ts` builds `SongModel` fixtures, so a change to the model
  does not mean editing ten files.

Fixtures must not depend on files that are not in the repository. A test that
reads a local MIDI and skips when it is absent means contributors run fewer
tests than the author, and nothing says so.

## Commit messages

Explain **why**, not what. The diff already says what changed. If a change is
subtle — a blockstate convention, a rounding rule, an ordering requirement —
say so in the message and, where it matters, in a comment next to the code.

Keep mechanical changes (formatting, renames, moving code between files) in
their own commit so they can be skipped in review and in `git blame`.

## Reporting bugs

Use the issue templates. For anything that produces a wrong schematic, a copy of
the MIDI (or the smallest one that still shows the problem) plus the settings you
used is worth more than a description.
