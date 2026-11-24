# Seats: players who take turns

A run can have up to eight seats: players who take turns in one game, such as
two players alternating shots at a pool table. Every player's page runs the
whole simulation, and all their inputs end up in one recording that replays
like any other. Nobody acts at the same time as anybody else, so
`capabilities.multiplayer` stays `false`.

A game with one seat, which is every game that does not declare `seats`, has
no turns, and nothing on this page applies to it.

## Declaring seats

```ts
session: { tickHz: 60, hasEnding: true, seats: 2 },
```

`seats` is a whole number from 1 to 8, and 1 when it is left out. It sits in
`session`, so the manifest hash covers it and a patch keeps it.

## Saying whose turn it is

A game with more than one seat implements `seat()`:

```ts
seat(): number {
  return this.turn
}
```

It answers the seat whose inputs the next tick reads, from 0 to one below
`seats`, as a pure function of the state. The kernel asks it exactly when it
asks `packsNeeded()`: once after `init`, once after `restore` and once after
every tick, in every host, so the number of calls never depends on the host
or the network. A `seat()` that changes state therefore changes it a
different number of times than the determinism check's extra call expects,
and the check reports `E_DETERMINISM_DIVERGED` naming `seat()`.

Leaving `seat()` out of a game with several seats, or answering anything but
a whole number below `seats`, is `E_SEAT_INVALID`.

The turn is state like any other. Keep it in the snapshot and put it back in
`restore`, or a run resumed at a turn change reads the wrong seat.

## What one tick reads

One tick reads one seat's inputs: the seat `seat()` named for it. An input is
never stamped with a seat. `tick()` receives inputs exactly as it does in a
one-seat game, and knows whose they are because it knows whose turn it is.

When the turn passes, every input the seat that stopped was holding counts as
released, and the host records no release for it. Let go of held state in
`tick()` at the turn change:

```ts
private pass(): void {
  this.turn = 1 - this.turn
  this.held = false        // the shooter's press ends with the turn
}
```

A page that pressed a key on its last tick of a turn and released it on the
other seat's tick would otherwise put an input on a tick that was not its
turn, and a server refuses that.

## The page

A page that plays a seat gives `GameHost` its seat and a feed for everybody
else's inputs:

```ts
const remote = new RemoteInputFeed(MANIFEST.inputs)
const host = new GameHost({
  ...rest,
  seats: {
    local: mySeat,
    remote,
    onLocalInputs: (events, throughTick) => socket.send({ events, throughTick }),
  },
})
socket.onmessage = ({ events, throughTick }) => {
  remote.append(events)
  remote.confirm(throughTick)
}
```

On its own turn the page reads its live queue, as any page does. On another
seat's turn it pauses the live queue, drops whatever the device helpers
release, and holds its loop until the feed is confirmed through the next
tick. `FrameInfo.waitingForSeat` and `host.waitingForSeat` name the seat it
is waiting for. A page that fell behind runs the ticks its feed has confirmed
faster than its clock, up to five a frame, until it is level with the sender.

`onLocalInputs` runs after each frame that ran a tick, with the local inputs
since the last call and the last tick the page has run. Send both. The
receiving page appends the inputs and confirms the tick.

`local: null` is a page that only watches: it has no live queue and reads
every tick from its feed, which a server fills with the merged log.

`host.recording()` is the merged log, every input every tick took. It
replays through `RecordedInputSource` to the same checkpoints, so a replay
of a seated run takes the recording's inputs and no `seats` option.

`GameHost` refuses `seats` for a one-seat game and requires it for a live run
of a game with more. The worker host runs one-seat games only.

## The server

A match server keeps one `RemoteInputFeed` per seat and plays them through a
`SeatedInputSource`, which takes from the acting seat's feed and refuses any
input another seat sent for that tick:

```ts
const feeds = [new RemoteInputFeed(inputs), new RemoteInputFeed(inputs)]
const source = new SeatedInputSource(feeds)
const session = new Session({ ...rest, inputs: source, seats: 2 })
while (session.running && feeds.every((f) => f.confirmedThrough >= session.tick)) {
  session.step()
}
const merged = source.recorded()
```

Whose turn a tick is comes from the game's `seat()`, never from the sender,
so a seat cannot act on another's turn: the input is `E_INPUT_SEAT` at the
tick it lands on. Pass `seats: seatsOf(manifest)` to every session of a
seated game, a replay included, or the first turn of seat 1 is
`E_SEAT_INVALID`.

## A feed's rules

- `append` takes inputs sorted by tick, across appends as well as within one
  (`E_INPUT_UNSORTED`), each a declared input in its range, by the same check
  the live queue and `checkInputs` run (`E_INPUT_UNDECLARED`). An input on a
  tick already confirmed is `E_INPUT_RANGE`. A refused append keeps nothing.
- `confirm(throughTick)` never goes back (`E_ARG_INVALID`).
- `take` for a tick past `confirmedThrough` is `E_INPUT_NOT_CONFIRMED`. The
  page host never does it, because it holds; a loop of your own must wait.
- An input for a tick the reader ran without the feed, because it was the
  reader's own turn, is `E_INPUT_SEAT` when the reader next takes.

## The checks

The `determinism` check plays a game that has `seat()` twice more: once
splitting the bot log by the seat whose turn each tick was, asking `seat()` an
extra time with the state hashed around it, and once playing each seat's
share through a `SeatedInputSource`. Both have to reach the states the plain
runs reached.
