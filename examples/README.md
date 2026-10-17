# Local test songs

Put MIDI files here to try them against the generator. This directory is in the
repository only for this note: **its contents are not committed.**

`*.mid` and `*.midi` are ignored at the repository root, and `examples/` does not override
that. Test songs are third-party music, so shipping them would be a licence problem — the
repository's own MIDI fixtures live in `test/fixtures/`, where they are tiny and purpose
built.

Typical use:

```bash
npm run cli -- "examples/Flower Dance.mid"     # generate without opening the window
```

Two songs used while developing this:

- `Flower Dance.mid` — 3,692 notes. The useful everyday case: long enough to exercise
  alignment and chord handling, short enough to generate in a fraction of a second.
- `Rush E.mid` — 46,291 notes. The stress case, for timing and memory. Generating it takes
  about 1.4 seconds; generating it twice, which the check step does, about 2.5.

Without those files the test suite still runs in full: nothing in `test/` reads from this
directory.
