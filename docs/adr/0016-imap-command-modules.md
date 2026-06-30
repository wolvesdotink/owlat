# IMAP command modules — per-verb deepening of the connection state machine

**Status:** proposed

## Context

`ImapConnection` in `apps/imap/src/connection.ts` is one 1106-LOC class
that tangles four structurally distinct concerns into one body. The
class owns the TLS / TCP socket, line buffering, IMAP literal
absorption, IDLE poll-timer lifecycle, per-connection auth + selected
state, and the dispatch for ~17 IMAP verbs. The unit of conceptual
change ("add `SEARCH`," "stop sending CHECK as a sync barrier," "fix
the FETCH envelope formatter") does not match the unit of physical
change (the file).

The file header explicitly notes that write commands (STORE / MOVE /
EXPUNGE / APPEND) "come in P5" — and yet they are already implemented
in the file (`connection.ts:228-238, 696-1018`). The class is past the
size where one more verb is a comfortable addition.

### Four shapes tangled in one class

1. **Pump.** `onData` (`connection.ts:102-161`) reads bytes from the
   socket, splits on `\r\n`, absorbs APPEND literal bodies a-byte-at-a-
   time, detects bare `DONE` to terminate IDLE, and dispatches every
   other line through `handleCommand`. This is the transport boundary
   and has nothing to do with IMAP semantics.

2. **Command dispatch.** `handleCommand` (`connection.ts:163-243`) is
   the 17-case switch over parsed verbs. Adding a verb is a switch
   edit; mis-spelling a case label is a runtime fallthrough to
   `default → BAD`.

3. **Per-verb compute.** ~14 verbs follow the same shape:
   `requireAuth` → (sometimes) `requireSelect` → one `convex.query` or
   `convex.mutation` → format response → `sendOk`. Three verbs break
   it: LOGIN (rate-limit + state transition), SELECT / EXAMINE (state
   transition), and the long-running pair IDLE / APPEND.

4. **Mid-flight session state.** `pendingAppend`, `idleTag`,
   `idleTimer`, `idlePollTimer` live on `this` next to `auth` and
   `selected` (`connection.ts:57-63`) — but they are *not* connection
   state. They exist for the duration of one in-flight command and
   are cleaned up when that command terminates. The pump and the
   sessions share them by convention; nothing on the class signals
   "owned by APPEND" vs "owned by IDLE" vs "owned by the connection."

### Six drift signals

| # | Site | Drift |
|---|---|---|
| 1 | `handleCommand:168-242` | 17-case switch over verbs; adding a verb is a switch edit |
| 2 | `flagsForFolder:359-384` | Inner switch over `role` (6 cases) lives inside LIST — also referenced by SELECT-side capability lines, copy/paste-prone |
| 3 | `formatFlags / formatInternalDate / formatEnvelope / imapString / imapAddrList` (lines 606-675) | FETCH-internal formatters living on the connection class. Tests would reach them only through a full FETCH integration |
| 4 | `requireAuth / requireSelect` (`:318-332`) | Gate predicates duplicated as bare ifs at the top of every authenticated handler. The compile-time guarantee is "no, you have to remember to call it" |
| 5 | `idleTag / idleTimer / idlePollTimer` (`:60-63, 1056-1105`) | Three fields cooperating to encode one IDLE session. `null` on every field is the "no IDLE in flight" sentinel |
| 6 | `pendingAppend` (`:62, 112-132, 902-950`) | Multi-phase: parsed during APPEND command (`handleAppend`), filled by `onData` byte absorption, drained by `processAppend`. The state object lives on the connection so the pump can see it; the verb's logic is split across three methods |

### Test surface today

Per-verb behavior cannot be unit-tested. The only available test path
is "spin up a real IMAP connection, drive a real TLS or TCP socket,
run a real LOGIN+SELECT prelude, then assert on response bytes." The
FETCH envelope formatter — pure functions over `Doc<'mailMessages'>`
shapes — cannot be exercised in isolation because they live as
private methods on the class.

The deletion test: delete the class's command-switch + `pendingAppend`
+ `idleTag` bookkeeping. The same concerns reappear at three sites
already today (LOGIN-related `auth!` bangs, SELECT-related `selected!`
bangs, IDLE's three null sentinels). A second IMAP server (a future
ManageSieve adapter, or a JMAP shim) would re-implement the same pump
+ dispatch pattern from scratch.

## Decision

A per-verb module folder plus a thin pump. Mirrors the **Block module**
(ADR-0001), **Step module** + **Step walker** (ADR-0004), and **Agent
step (module)** + **Agent walker** (ADR-0014) patterns already used in
the codebase. The vocabulary lands in CONTEXT.md under a new "IMAP"
section.

### Module shape

```ts
interface ImapCommandModule<TArgs> {
  readonly verbs: readonly ImapVerb[];
  readonly capabilities?: readonly string[]; // CAPABILITY-line atoms
  parseArgs(rawArgs: string[], verb: ImapVerb): TArgs | { error: string };
  start(
    deps: CommandDeps,
    state: ConnectionState,
    args: TArgs,
    tag: string,
    verb: ImapVerb,
    send: (line: string) => void,
  ): CommandSession;
}

interface CommandSession {
  /** Resolves when the command terminates. Pump treats the returned
   *  next state as the new ConnectionState. */
  readonly completion: Promise<{ state: ConnectionState }>;
  /** Set when the module needs the pump to absorb N raw bytes into
   *  `onLiteralBytes` before the session can resolve. */
  readonly awaitingLiteral?: { bytes: number };
  /** Called by the pump when a line arrives while this session is
   *  active. Returns 'absorbed' (don't dispatch through walker) or
   *  'pass' (treat as a fresh command). IDLE absorbs bare DONE. */
  onClientLine?(line: string): 'absorbed' | 'pass';
  /** Called by the pump when literal bytes arrive while
   *  `awaitingLiteral` is set. */
  onLiteralBytes?(buf: Buffer): void;
  /** Called by the pump on socket close. Modules tear down timers /
   *  pending mutations here. */
  cancel(): void;
}

interface ConnectionState {
  readonly auth: AuthState | null;
  readonly selected: SelectedState | null;
}

interface CommandDeps {
  readonly convex: ConvexClient;
  readonly config: ImapConfig;
  readonly rateLimiter: AuthRateLimiter;
  readonly remoteIp: string;
}
```

One interface covers both shapes. **One-shot** commands return a
session whose `completion` is already resolved when `start` returns —
the pump writes lines through the supplied `send` callback during
`start` and then clears the active-session slot. **Long-running**
commands (IDLE, APPEND) return a pending session; the pump tracks the
slot until `completion` resolves and routes intermediate input through
the optional hooks.

### Folder layout

```
apps/imap/src/
  commands/
    capability/index.ts
    noop/index.ts
    logout/index.ts
    id/index.ts
    namespace/index.ts
    enable/index.ts
    login/index.ts            # rate-limit + Convex verifyAppPassword
    list/index.ts             # verbs: ['LIST', 'LSUB']
    select/index.ts           # verbs: ['SELECT', 'EXAMINE']
    unselect/index.ts         # verbs: ['UNSELECT', 'CLOSE']
    status/index.ts
    fetch/
      index.ts                # verbs: ['FETCH']
      format.ts               # formatFlags / formatEnvelope / imapString / imapAddrList
    uid/index.ts              # dispatches FETCH/STORE/COPY/MOVE/EXPUNGE sub-verbs
    idle/index.ts             # long-running; owns poll timer + idleTimer
    check/index.ts
    store/index.ts
    copy/index.ts
    move/index.ts
    expunge/index.ts
    append/index.ts           # long-running via awaitingLiteral
    helpers/
      auth.ts                 # requireAuth / requireSelect — pure predicates
      folders.ts              # resolveFolderByName / listFolders gate
      uidSet.ts               # collectMessageIds (parseUidSet stays in parser.ts)
    types.ts                  # ImapCommandModule / CommandSession / ConnectionState / CommandDeps / ImapVerb
    walker.ts                 # typed dispatch table + dispatch()
  connection.ts               # the IMAP pump — buffer, literal absorption, session slot
  parser.ts                   # unchanged
  server.ts                   # unchanged
  config.ts, convex.ts, mime.ts, rateLimit.ts, logger.ts # unchanged
```

The folder shape exactly mirrors `convex/agent/steps/<kind>/` and
`convex/automations/steps/<kind>/`. Adding a verb is one folder; missing
a walker registry entry is a compile error.

### Pump shape after the cut

```ts
export class ImapConnection {
  private buffer = '';
  private state: ConnectionState = { auth: null, selected: null };
  private activeSession: CommandSession | null = null;

  constructor(
    private socket: Socket | TLSSocket,
    private config: ImapConfig,
    private convex: ConvexClient,
    private rateLimiter: AuthRateLimiter,
    private remoteIp: string,
  ) {
    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => this.activeSession?.cancel());
    this.send(`* OK [${assembleCapabilityLine()}] ${config.greetingHost} Owlat IMAP ready`);
  }

  private onData(chunk: string) {
    this.buffer += chunk;

    // 1. If a session is awaiting literal bytes, absorb them.
    if (this.activeSession?.awaitingLiteral) { /* feed onLiteralBytes */ }

    // 2. Drain whole lines from the buffer.
    while (hasCompleteLine(this.buffer)) {
      const line = takeLine(this.buffer);

      // 2a. If a session is active and wants this line, give it.
      if (this.activeSession?.onClientLine?.(line) === 'absorbed') continue;

      // 2b. Otherwise parse and dispatch.
      const parsed = parseLine(line);
      if (!parsed) continue;
      const session = dispatch(
        { convex: this.convex, config: this.config, rateLimiter: this.rateLimiter, remoteIp: this.remoteIp },
        this.state,
        parsed,
        (l) => this.send(l),
      );
      this.trackSession(session);
    }
  }

  private async trackSession(session: CommandSession) {
    this.activeSession = session;
    const { state } = await session.completion;
    this.state = state;
    if (this.activeSession === session) this.activeSession = null;
  }
}
```

`connection.ts` shrinks from 1106 LOC to ~150. The pump never imports
a verb name. The class is the GroupMQ adapter of `apps/imap/` — its
job is socket I/O and session tracking, nothing else.

## Considered options

### Scope

1. **Deepen only the 14 uniform commands, leave IDLE / APPEND in the
   pump.** Smaller blast radius. Rejected because the deletion test
   fails on the residual state: `pendingAppend`, `idleTag`,
   `idleTimer`, `idlePollTimer` would stay on `ImapConnection`, and
   the deepening doesn't yield the testability win — the most
   complex commands (IDLE's timer dance, APPEND's literal-absorption
   handshake) remain untestable.
2. **Full deepening + per-verb modules** *(chosen)*. The interface
   absorbs the long-running shape via optional hooks; sessions are
   uniform.
3. **Full deepening + two parallel module hierarchies** (one for
   one-shot, one for long-running). Rejected — the verb is the
   natural dispatch key. Splitting the registry by shape forces the
   dispatcher to check two tables for every verb, and APPEND vs
   STORE vs FETCH have nothing else in common shape-wise.

### Module I/O contract

1. **Pure `(state, args) → { state', lines }`.** Smallest interface,
   no callbacks. Cannot express IDLE (asynchronous timer pushes) or
   APPEND (gradual byte absorption) without bolted-on side channels.
   Rejected.
2. **Single `execute` method with completion promise** *(chosen)*.
   `start` returns a `CommandSession`; one-shot sessions have already-
   resolved `completion`, long-running ones have pending. The pump
   awaits `completion` to learn the next state. Optional
   `onClientLine` / `onLiteralBytes` / `awaitingLiteral` hooks express
   long-running concerns without leaking into one-shot modules.
3. **Two module interfaces (`OneShotCommandModule`,
   `LongRunningCommandModule`).** Type-level clarity that not every
   command has to think about literals or DONE handling. Rejected
   because (a) the dispatch table becomes a discriminated union the
   walker has to narrow on every line, and (b) the optional hooks
   on (2) cost almost nothing for one-shot modules — they just don't
   set them.

### State threading

1. **Mutable `ConnectionState` injected into modules** (closest to
   today). Rejected — defeats half the test win. Modules mutating a
   shared object means concurrent commands could race, even if today
   IMAP is single-flight.
2. **Immutable `ConnectionState` returned via `session.completion`**
   *(chosen)*. Modules receive a snapshot, compute the next state
   atomically. The pump applies the next state when the session
   resolves. LOGIN's `auth: null → AuthState` and SELECT's `selected:
   null → SelectedState` are one-liners. Tests assert on the next
   state value, not on a mutated reference.
3. **Per-module `ConnectionHandle` with typed getters/setters.**
   Middle ground; carries the implicit-mutation downsides of (1)
   without the testability win of (2). Rejected.

### Multi-verb modules

1. **One module per verb** (`list.ts`, `lsub.ts`, `select.ts`,
   `examine.ts`, …). Cleanest one-to-one mapping. Rejected because
   IMAP pairs (LIST / LSUB, SELECT / EXAMINE, UNSELECT / CLOSE,
   STORE / UID STORE) genuinely share implementation — keeping them
   apart would mean either duplicating bodies or one re-exporting the
   other.
2. **One module declares multiple verbs** *(chosen)*. The module's
   `verbs` array is the registration; the verb arrives in `start()`
   so the module can branch on it (e.g. LIST vs LSUB filtering
   `subscribed`).
3. **One module per logical command, but with a separate `aliases`
   field.** Same as (2) but with extra ceremony. Rejected.

### UID prefix

1. **Each UID sub-command is its own walker entry** (`'UID FETCH'`,
   `'UID STORE'`, …). Flat namespace. Rejected because the parser
   doesn't know about UID prefixing — `parser.ts:parseLine` returns
   the verb as a single token. Adding UID-prefix awareness to the
   parser couples it to IMAP's command grammar.
2. **One `UID` module that internally dispatches to sub-verb
   modules** *(chosen)*. `commands/uid/index.ts` reads `args[0]`,
   looks up the matching sub-module in the registry, calls its
   `start` with the `byUid: true` flag threaded through args. Mirrors
   today's `handleUid` at `connection.ts:512-530` but as a real
   module.

### CAPABILITY assembly

1. **Static `CAPABILITY_LINE` constant.** Today's shape. Adding
   `MOVE` support requires editing the constant *and* implementing
   the verb. Rejected — drift surface.
2. **Aggregated from per-module `capabilities?` declarations**
   *(chosen)*. The walker exposes `assembleCapabilityLine() → string`
   that concatenates `'IMAP4rev1 AUTH=PLAIN'` (the protocol baseline)
   with every registered module's `capabilities` array. Adding `MOVE`
   means adding `capabilities: ['MOVE']` to `commands/move/index.ts`
   — one place.

### File layout

1. **Flat: `commands/*.ts`.** Each verb is one file at the
   `commands/` root. Lighter. Rejected because FETCH already has its
   internal formatters (`format.ts`) that are FETCH-internal — those
   need a sibling location, which means at least FETCH gets a folder.
   Inconsistency for one verb means the convention isn't a
   convention.
2. **Per-verb folder** *(chosen)*. `commands/<verb>/index.ts` with
   sibling files (helpers, formatters, sub-modules) as needed. Mirrors
   the **Block module** and **Step module** patterns. Tests
   co-locate under `__tests__/`.

## Consequences

### Files that collapse / disappear

- `apps/imap/src/connection.ts` shrinks from 1106 LOC to ~150. The
  17-case switch in `handleCommand`, every `handleX` private method,
  the FETCH formatters, the `flagsForFolder` switch, `requireAuth` /
  `requireSelect`, `resolveFolderByName`, `collectMessageIds`,
  `fetchRawBody`, the IDLE timer dance, and the APPEND literal
  absorption all leave the file. The class becomes the IMAP pump and
  nothing else.
- `CAPABILITY_LINE` (`connection.ts:26-27`) becomes
  `assembleCapabilityLine()` in `commands/walker.ts`.

### Files that grow

- `apps/imap/src/commands/<verb>/index.ts` × ~17 (new). Most are
  20–60 LOC; FETCH and APPEND are larger (~150 each) because of their
  intrinsic complexity.
- `apps/imap/src/commands/fetch/format.ts` (new, ~80 LOC). The
  formatters live here.
- `apps/imap/src/commands/helpers/{auth,folders,uidSet}.ts` (new,
  ~30 LOC each). Pure helpers shared across modules.
- `apps/imap/src/commands/types.ts` (new, ~60 LOC). The interfaces
  and the `ImapVerb` union.
- `apps/imap/src/commands/walker.ts` (new, ~80 LOC). The typed
  registry, `dispatch()`, `assembleCapabilityLine()`.

Net LOC change is roughly flat: connection.ts sheds ~950 LOC; the
commands folder gains ~1100 LOC including types and tests scaffolding.
The value is locality, typing, and test surface — not line count.

### Test surface

Today: zero per-verb unit tests; one integration suite against a real
socket.

After:

- `commands/<verb>/__tests__/<verb>.test.ts` per module. Construct a
  synthetic `ConnectionState`, stub `CommandDeps.convex` with the
  Convex client mock pattern already used in `apps/api/convex`
  integration tests, call `start`, assert on the `send` callback
  history and the resolved `completion.state`. No socket required.
- `commands/__tests__/walker.test.ts`. Type-level test that the
  dispatch table is exhaustive over `ImapVerb`. Runtime test that
  unknown verbs produce a BAD response without crashing.
- `commands/idle/__tests__/idle.test.ts`. Fake timers (Vitest
  `vi.useFakeTimers()`). Assert that the IDLE session pushes
  `* N EXISTS` on poll, that `onClientLine('DONE')` resolves
  `completion`, and that `cancel()` clears both timers.
- `commands/append/__tests__/append.test.ts`. Feed `onLiteralBytes`
  in chunks; assert the upload mutation runs exactly once when the
  declared byte count is satisfied, and the session resolves
  `completion` with the `APPENDUID` response.
- `__tests__/connection.test.ts`. Pump-only smoke: line splitting,
  literal absorption routing, session lifecycle. Uses a fake socket;
  no real TLS.

The existing integration suite stays as smoke coverage.

### Behavior

Pure refactor. No wire-visible changes, no Convex-side mutation
changes, no `mailMessages` schema changes. The CAPABILITY line is
identical post-deepening (same atoms, same order — the assembler
preserves order from the registration sequence).

Three things are *opportunistically* fixed in passing because the new
shape makes them obvious; each is scoped to its own commit in the
execution plan:

- `flagsForFolder` (`connection.ts:359-384`) duplicates folder-role
  → IMAP-flag mapping that LSUB and STATUS could also use. After the
  cut, that lives in `commands/helpers/folderFlags.ts` and is one
  source of truth.
- `formatInternalDate` (`connection.ts:624-633`) silently uses UTC
  for all dates — preserved verbatim, but it surfaces in
  `commands/fetch/format.ts` where future per-locale handling would
  land.
- The known utf-8-decode bug for 8-bit APPEND bodies
  (`connection.ts:106-111`) stays unfixed in this ADR — Buffer-mode
  rewrite is its own correctness work tracked separately. The
  per-module test for APPEND makes the bug far easier to *prove*
  exists in a regression.

### Vocabulary

CONTEXT.md gains an **IMAP** section between **Inbox processing** and
**Abuse**. Five new terms — **IMAP command (module)**, **Connection
state**, **IMAP pump**, **IMAP command walker**, and (implicitly)
**`CommandSession`** — pin the language used in this ADR and in
subsequent reviews. The Relationships section gains one paragraph
linking the IMAP pump → walker → command-module chain and noting that
APPEND lands a `mailMessages` row that the **Postbox outbound
lifecycle (module)** and **Inbox processing lifecycle (module)** then
take ownership of.

Example dialogue gains two entries: "adding a new IMAP command" and
"how IDLE / APPEND fit the same interface as one-shot commands."

### What this does *not* cover

- **Buffer mode for 8-bit APPEND.** The utf-8 decoded buffer is a
  known correctness debt called out in the file header. The
  deepening makes the bug easier to test for but does not fix it. A
  follow-up ADR introduces a `Buffer`-mode rewrite of the pump's
  byte handling.
- **Native push for IDLE.** The 5-second polling loop becomes a
  proper Convex subscription "in P5" per the existing comment
  (`connection.ts:1061-1062`). The deepening leaves the polling as
  the IDLE module's responsibility; switching to a subscription
  becomes a one-module change.
- **`AUTHENTICATE` / SASL mechanisms.** Today only `LOGIN` (PLAIN
  over TLS) is supported. Future SASL support adds an
  `AUTHENTICATE` module alongside `LOGIN` — out of scope here.
- **Folder management commands** (`CREATE`, `DELETE`, `RENAME`,
  `SUBSCRIBE`, `UNSUBSCRIBE`). Not implemented today; not in scope
  here. They drop into the same folder pattern when they land.

## Follow-up work

1. **Buffer-mode pump.** Replace the utf-8-decoded `string` buffer
   with `Buffer` handling so 8-bit APPEND bodies round-trip
   correctly. Tracked as separate ADR. The deepening lands first so
   the buffer-mode rewrite touches only `connection.ts`, not 1100
   lines of mixed code.
2. **IDLE native push.** Once Convex exposes a server-side push
   mechanism the `commands/idle/` module replaces its `setInterval`
   loop with the subscription. One-module change.
3. **ManageSieve adapter.** Owlat may grow a ManageSieve server for
   filter management. The pump + walker shape transfers directly —
   ManageSieve has the same line-oriented + literal-aware grammar.
   The deepening makes that copy a real copy (~150 LOC pump shell)
   rather than a re-discover.
4. **Capability negotiation tests.** With CAPABILITY-line assembly
   driven by per-module `capabilities?` declarations, a test that
   asserts "the assembled line is exactly `IMAP4rev1 AUTH=PLAIN ID
   IDLE LITERAL+ ...`" gives us a regression net for accidental
   capability removals.

## Execution

See `docs/adr/0016-execution-plan.md` (to be drafted alongside this
ADR's acceptance).
