# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/xingtuan416/MusicboxMC/security/advisories/new)
instead, or email the address on the maintainer's GitHub profile.

Include what you did, what happened, and what you expected. A sample file that
triggers it helps more than a description.

This is a spare-time project, so there is no guaranteed response time. Reports
that come with a reproduction get looked at first.

## Supported versions

Only the latest release is supported. There are no maintenance branches.

## What this application does

Understanding the threat model makes reports easier to judge.

MusicboxMC is a local desktop application. It has **no server component and
makes no network requests**. It reads a MIDI file you choose, converts it, and
writes a `.litematic` schematic to a path you choose in a save dialog.

That leaves one realistic attack surface: **malformed input files**. A MIDI file
is parsed by `@tonejs/midi`, and this project's own NBT and litematic readers
parse files back for verification.

## How the Electron app is hardened

These are deliberate choices, so please do not report them as missing:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The
  renderer has no Node access.
- The renderer talks to the main process only through a narrow, typed API
  exposed by `src/preload/index.ts`. It cannot ask for arbitrary file reads.
- Paths arriving over IPC are validated with `existsSync` before use, so a
  renderer cannot turn a string into a file operation on something that is not
  there.
- The renderer is served from a custom `app://` scheme with a handler that
  refuses any path outside the renderer directory, rather than being handed the
  file system through `file://`.
- Output bytes are built in memory and written only to the path from the save
  dialog.

## In scope

- A malformed MIDI or `.litematic` file that causes a crash, an out-of-bounds
  read, unbounded memory growth, or arbitrary file access.
- A way for the renderer to reach Node.js APIs or the file system beyond what
  the preload bridge exposes.
- A generated file that escapes the schematic bounds and could damage a world
  when pasted, such as coordinates outside the region they are declared in.

## Out of scope

- Denial of service from simply feeding in a very large song. Long songs take
  longer and use more memory; that is expected, and the GUI reports the cost.
- Anything requiring an already-compromised machine, or a modified build.
- The Minecraft side. Nothing in this project runs inside the game, and pasting
  a schematic is Litematica's job. Report bugs that are genuinely about the
  generated structure here; report Litematica's behaviour to Litematica.
