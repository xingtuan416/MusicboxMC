# Documentation

Start here:

- [English project guide](README.en.md)
- [Logic guide](logic-guide.md) — how the converter works, in plain language and
  without code: pipeline, one track's topology, timing, alignment, Z layout, lead
  track, merging, borrowing, riding, signs, command playback (Chinese).
- [Constants and thresholds](constants.md) — every constant the code uses, each
  labelled as a game fact, a repository convention, an implementation choice or an
  external assumption, with the file that uses it (Chinese).
- [Project status](status.md) — current version, quality gates and the items
  waiting for a decision (Chinese).
- [Known issues and limitations](known-issues.md) — the authoritative, ID-based list
  of code problems, release limitations and maintenance debt.

Reference:

- [Architecture](architecture.md) — layering, data flow, and where to change what.
- [Redstone model](redstone-model.md) — topology, timing, alignment, and the
  simulation this project deliberately does not do.
- [Multi-instrument model](multi-instrument.md) — the sixteen instruments, the GM
  and name maps, the two modes, substitutions and octave fitting.
- [Command playback](command-playback.md) — the schedule, the command chain, the
  budget and the in-game requirements.
- [Litematic format](litematic-format.md) — bit packing, index order and region rules.

History:

- [Changelog](CHANGELOG.md)
- [0.4.0 implementation plan](0.4.0-plan.md) — the round-by-round record of the
  0.4.0 work (read as history: later rounds supersede earlier sections, and the
  banner at the top lists what changed).
- [0.4.5 fix plan](0.4.5-plan.md) — the UI and layout fixes requested for 0.4.5,
  each with its current code location, the intended change and the open questions.
