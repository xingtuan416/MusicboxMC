## What this changes

<!-- One or two sentences. If it fixes a bug, say what the bug was. -->

## Why

<!-- The reasoning. The diff already shows what changed; this is for why. -->

## How it was verified

<!--
Say what you actually ran. "npm test passes" is a starting point, not an answer
for anything that changes generated output.
-->

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`

## Checklist

- [ ] Behaviour changes come with a test, and the test checks the behaviour
      rather than restating the implementation.
- [ ] Any new failure in `src/core/` throws a `CoreError` with a code, and the
      matching text was added to `src/main/messages.ts`.
- [ ] Any new warning code is declared, emitted **and** given text — the
      `warningCoverage` test fails if not.
- [ ] Comments say why, not what.
- [ ] Mechanical changes (formatting, renames, moving code) are in their own
      commit.

## Generated output

<!--
Complete this section if the change can alter a generated schematic. Delete it
otherwise.
-->

- What changes in the output:
- Was this checked in game, and in which Minecraft version:
- Does it affect the size of the schematic, the number of blocks, or the timing:
