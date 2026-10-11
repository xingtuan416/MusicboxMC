# Command playback backend

An alternative to the redstone backend. Instead of building a circuit, every note
becomes a `playsound` command, executed for each online player at their own
position. The output is still a Java 1.20.4 `.litematic`.

Use it when the redstone limits are the problem: a redstone circuit has to be
heard near the circuit, and its polyphony is capped by signal strength. Command
playback has neither limit, at the cost of requiring command blocks and of
shifting the load onto the server's command budget.

## Why it is compact

The obvious implementation — one command block per note — does not scale. A
46,000-note song becomes 46,308 command blocks and a 348 KB schematic, and the
command chain has to walk all 46,293 steps on every single game tick.

Instead, `core/command/playback.ts` stores the schedule as data and reuses a
bounded number of commands:

- **Voice** — a distinct `(sound, pitch)` pair. At most five note-block
  instruments × 25 note values, so a few dozen in practice.
- **Frame** — one game tick on which anything happens, stored as
  `[tick, countForVoice0, countForVoice1, ...]`.
- **Slot** — a command per `(voice, occurrence)`. A voice that can sound 5 times
  at once needs 5 slot commands; the count in the frame decides how many of them
  actually fire.

The structure therefore grows with _frames × voices × peak multiplicity_, not
with the note count. For a 40,000-note dense song the player stays under 1,000
command blocks.

## How it runs

Bootstrap (once, from the Start control):

```
scoreboard objectives add <objective> dummy
data modify storage <storage> frames set value []      # then appended in chunks
scoreboard players set #tick <objective> -1
scoreboard players set #playing <objective> 1
```

Per game tick, from the repeating command block at the head of the chain:

```
execute if score #playing <objective> matches 1 run scoreboard players add #tick <objective> 1
execute if score #playing <objective> matches 1 store result score #next <objective> run data get storage <storage> frames[0][0]
<for each voice>  ... store result score #v<i> ... run data get storage <storage> frames[0][<i+1>]
<for each voice, for each slot k>
    execute if score #playing <objective> matches 1 if score #tick <objective> = #next <objective> \
      if score #v<i> <objective> matches k.. as @a at @s run playsound <sound> record @s ~ ~ ~ 1 <pitch>
data remove storage <storage> frames[0]
execute if score #playing <objective> matches 1 unless data storage <storage> frames[0] run scoreboard players set #playing <objective> 0
```

The frame table is shipped inside the schematic as `data modify storage ... set
value [...]` commands, split so that no single command approaches NBT's 65,535
byte string limit. That is why the raw command text is much larger than the
compressed file.

## Geometry and controls

The chain occupies a 32×32 serpentine, one layer per 1,024 commands, so long
chains stay compact instead of running off into the distance. Coordinates are
relative to the schematic origin; the GUI lists the actual positions.

Two controls are placed alongside:

- **Start / Restart** — writes a redstone block next to the clock, running the
  bootstrap chain.
- **Stop** — clears `#playing`, removes the power block, and stops the five
  note-block sound events.

## Scoreboard namespace

The objective name is `mb` plus the first 12 hex digits of the SHA-256 of the
scheduled events, and the storage key is `musicboxmc:<objective>`. Two exports
generated from the same input and options therefore share a namespace — running
them at the same time would corrupt each other. Generate with different input if
you need to play two at once.

## Budgets and warnings

| warning                         | meaning                                                               |
| ------------------------------- | --------------------------------------------------------------------- |
| `COMMAND_PLAYBACK_REQUIREMENTS` | always emitted; reports chain length and the configured budget        |
| `COMMAND_SOUND_PRESSURE`        | peak simultaneous notes above 31; the client sound pool may drop some |
| `COMMAND_STRUCTURE_SIZE`        | more than 4,096 command blocks; pasting and loading get slow          |

`chainLength` must be **strictly less than** `commandChainBudget`, which defaults
to the vanilla `maxCommandChainLength` of 65,536. Exceeding it fails the export
rather than truncating the music.

## In-game requirements

- Creative mode or operator, with command blocks enabled
  (`enable-command-block=true` on a dedicated server).
- Paste **with block entity NBT**. Pasting only the block appearance loses the
  `TileEntities` and the player will not work. Check the commands and the
  Always Active flag after pasting.
- The whole structure must be in loaded chunks. Command playback does not remove
  the chunk-loading requirement.
- `maxCommandChainLength` must be at least the generated chain length. If the
  server changed it, enter the real value in the budget field.
- Consider turning off the world's `commandBlockOutput` to keep admin chat
  readable. The generator does not change world rules.

## Known limitations

- **The chain is walked every tick, including while idle.** Every command block
  in it is written with `conditional: false`, so the `if score #playing ...`
  guard makes each command a no-op rather than skipping the traversal. A large
  player therefore costs server time even when stopped.
- Playback sends a sound to every player, so command execution, network and
  client-side sound load all increase with player count.
- The client sound pool, sample tail overlap and server TPS still bound what is
  actually audible. The 31-note warning is a pressure hint, not a guaranteed
  safe capacity for every version or sound card.
- Like the redstone backend, this uses neither MIDI note duration nor velocity.

## See also

- [architecture.md](architecture.md) — where this code lives
- [redstone-model.md](redstone-model.md) — the default backend
