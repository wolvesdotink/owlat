/**
 * Interfaces shared across every **IMAP command (module)**.
 *
 * The deepening from one 1100-LOC connection class to per-verb modules
 * hangs off these types. Modules receive a `CommandDeps` + immutable
 * `ConnectionState` snapshot, do their per-verb work, and return a
 * `CommandSession`. The IMAP pump (`connection.ts`) tracks active
 * sessions and routes subsequent input through them.
 *
 * See CONTEXT.md → IMAP section and docs/adr/0016-imap-command-modules.md.
 */

import type { ImapConfig } from '../config.js';
import type { ConvexClient } from '../convex.js';
import type { AuthRateLimiter } from '../rateLimit.js';

/** Per-connection auth — populated by LOGIN, cleared on LOGOUT. */
export interface AuthState {
	readonly mailboxId: string;
	readonly appPasswordId: string;
	readonly address: string;
	readonly userId: string;
}

/** The currently-SELECTed folder. Cleared by UNSELECT / CLOSE. */
export interface SelectedState {
	readonly folderId: string;
	readonly folderName: string;
	readonly role?: string;
	readonly uidValidity: number;
	readonly uidNext: number;
	readonly highestModseq: number;
	readonly totalCount: number;
	readonly readOnly: boolean;
}

/**
 * Pure state threaded between IMAP commands. Distinct from the **pump
 * state** (buffer + active session) which the connection class owns.
 */
export interface ConnectionState {
	readonly auth: AuthState | null;
	readonly selected: SelectedState | null;
	/**
	 * Client identifier captured from the RFC 2971 ID command (e.g.
	 * `"Thunderbird"`), if the client sent one before LOGIN. Threaded so
	 * LOGIN can record it as the app-password `lastUsedUa`. `null` until
	 * an ID command with a recognisable `name` arrives.
	 */
	readonly clientId: string | null;
}

/** Per-process deps every module receives. */
export interface CommandDeps {
	readonly convex: ConvexClient;
	readonly config: ImapConfig;
	readonly rateLimiter: AuthRateLimiter;
	readonly remoteIp: string;
	/**
	 * The CAPABILITY line assembled by the walker from every module's
	 * `capabilities?` declaration — the same string used in the greeting,
	 * the post-LOGIN banner, and the CAPABILITY command's `* CAPABILITY`
	 * response. Starts with the literal `CAPABILITY ` token.
	 */
	readonly capabilityLine: string;
	/**
	 * Whether the underlying socket is TLS-encrypted. `false` only on the
	 * dev plaintext-TCP fallback. Credential-bearing commands (LOGIN,
	 * AUTHENTICATE PLAIN) refuse to run with `[PRIVACYREQUIRED]` when this
	 * is `false`, and the capability line drops `AUTH=PLAIN` / adds
	 * `LOGINDISABLED` (RFC 3501 §11.1, RFC 2595).
	 */
	readonly tls: boolean;
	/**
	 * Called by LOGOUT (and, on IDLE timeout, by the IDLE module) to tear
	 * down the socket. The pump's implementation is `socket.end()`.
	 */
	readonly closeConnection: () => void;
	/**
	 * Apply a state transition to the pump synchronously. State-changing
	 * modules (LOGIN, SELECT, UNSELECT, EXPUNGE, IDLE poll updates) call
	 * this directly so the next command dispatched off `this.state` sees
	 * the new value — bypassing the microtask hops that a completion-based
	 * state return would add.
	 */
	readonly commit: (state: ConnectionState) => void;
}

/**
 * Every parsed-args output uses this shape so the walker can emit a BAD
 * response uniformly without each module open-coding the same call.
 */
export type ParseResult<T> = { ok: true; args: T } | { ok: false; error: string };

/**
 * The handle a module returns from `start`. One-shot commands return a
 * session with neither `onClientLine` nor `awaitingLiteral` — the pump
 * treats them as fire-and-forget and just awaits `completion` for the
 * next state. Long-running commands (IDLE, APPEND) set one or both, and
 * the pump tracks them in the active-session slot until `completion`
 * resolves.
 */
export interface CommandSession {
	/**
	 * Resolves when the command terminates. State transitions are applied
	 * via `deps.commit` *before* completion resolves so the next command
	 * dispatched off the pump's state field sees the new value. Failures
	 * must still resolve — modules emit their own NO/BAD responses;
	 * throwing here would crash the pump.
	 */
	readonly completion: Promise<void>;
	/**
	 * When set, the pump absorbs exactly `bytes` raw bytes from the wire
	 * into `onLiteralBytes` before parsing further lines. APPEND uses
	 * this to swallow the `{N+}` literal body.
	 */
	readonly awaitingLiteral?: { bytes: number };
	/**
	 * Called by the pump for each line that arrives while this session is
	 * the active long-running session. Return 'absorbed' to consume the
	 * line (IDLE swallows bare `DONE`); return 'pass' to let the pump
	 * dispatch the line as a fresh command (no IMAP verb currently does
	 * this, but it keeps the door open).
	 */
	onClientLine?(line: string): 'absorbed' | 'pass';
	/**
	 * Called when literal bytes arrive while `awaitingLiteral` is set.
	 * Chunks may arrive in pieces; the pump stops calling when the
	 * declared byte count is satisfied.
	 */
	onLiteralBytes?(buf: Buffer): void;
	/**
	 * Called on socket close. Modules tear down timers, abort pending
	 * Convex mutations, etc. Idempotent — pump calls it at most once.
	 */
	cancel(): void;
}

/** The closed verb namespace dispatched by the walker. */
export type ImapVerb =
	| 'CAPABILITY'
	| 'NOOP'
	| 'LOGOUT'
	| 'ID'
	| 'NAMESPACE'
	| 'ENABLE'
	| 'LOGIN'
	| 'AUTHENTICATE'
	| 'LIST'
	| 'LSUB'
	| 'SELECT'
	| 'EXAMINE'
	| 'UNSELECT'
	| 'CLOSE'
	| 'STATUS'
	| 'FETCH'
	| 'UID'
	| 'IDLE'
	| 'CHECK'
	| 'STORE'
	| 'COPY'
	| 'MOVE'
	| 'EXPUNGE'
	| 'APPEND';

/**
 * A per-verb module. Lives at `commands/<verb>/index.ts`. Modules are
 * pure with respect to I/O — they receive `send` from the pump and
 * never touch the socket directly.
 */
export interface ImapCommandModule<TArgs = unknown> {
	readonly verbs: readonly ImapVerb[];
	/**
	 * CAPABILITY-line atoms this module contributes. The walker
	 * assembles them into the greeting + post-LOGIN banner +
	 * CAPABILITY response.
	 */
	readonly capabilities?: readonly string[];
	parseArgs(rawArgs: string[]): ParseResult<TArgs>;
	start(args: StartArgs<TArgs>): CommandSession;
}

export interface StartArgs<TArgs> {
	readonly deps: CommandDeps;
	readonly state: ConnectionState;
	readonly args: TArgs;
	readonly tag: string;
	readonly verb: ImapVerb;
	readonly send: (line: string) => void;
}
