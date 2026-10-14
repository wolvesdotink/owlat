/**
 * Admission rules for a non-APPEND command assembled across `{N}` / `{N+}`
 * literal continuations (RFC 3501 §4.3, RFC 7888): the memory bounds the IMAP
 * pump (`connection.ts`) applies before it invites or buffers a literal. APPEND
 * streams its body through the session `awaitingLiteral` path instead and is
 * not counted here.
 */

/**
 * Pre-auth literal ceiling. Before LOGIN succeeds the only legitimate `{N}`
 * literal a client sends is its credentials (a username / password — tens of
 * bytes), so an unauthenticated peer never needs more than a few KiB. Capping
 * the command-literal path here keeps the pre-auth per-connection memory ceiling
 * bounded (~this many bytes) instead of letting it rise to `maxLiteralBytes`
 * (50 MiB) — closing a pre-auth memory-amplification DoS where a peer declares a
 * huge `{N}` for any verb and forces the pump to buffer it before dispatch.
 */
const PRE_AUTH_LITERAL_BYTES = 4 * 1024;
/**
 * Aggregate ceiling on one assembled command (raw octets of every text segment
 * plus every literal). The per-literal caps alone do not bound memory: a peer
 * can chain any number of individually legal literals into one never-finished
 * command. Pre-auth fits a literal LOGIN with two full-size credential
 * literals; post-auth it admits one maximum literal plus one maximum line.
 */
const PRE_AUTH_COMMAND_BYTES = 3 * PRE_AUTH_LITERAL_BYTES;
/**
 * Literal-declaration ceilings for one command. Counted at admission, so
 * zero-length literals (no octets, nothing absorbed) count like any other and
 * cannot grow the segment arrays and parser work without bound.
 */
const PRE_AUTH_COMMAND_LITERALS = 8;
const MAX_COMMAND_LITERALS = 1024;

/**
 * A multi-line command being assembled across literal continuations
 * (e.g. `LOGIN {4}\r\nuser {8}\r\npassword`). `segments` are the decoded
 * text pieces with their trailing `{N}` token stripped; `literals` are
 * the absorbed literal values, interleaved so
 * `segments.length === literals.length + 1` once complete.
 */
export interface PendingCommand {
	readonly segments: string[];
	readonly literals: string[];
	/** Raw octets admitted so far: every segment line plus every literal. */
	bytes: number;
}

export interface CommandLimits {
	readonly preAuth: boolean;
	readonly maxLiteralBytes: number;
	readonly maxLineBytes: number;
}

export type Admission =
	| { readonly ok: true; readonly pending: PendingCommand }
	| { readonly ok: false; readonly reason: 'Literal too large' | 'Command too large' };

function commandByteBudget(limits: CommandLimits): number {
	return limits.preAuth ? PRE_AUTH_COMMAND_BYTES : limits.maxLiteralBytes + limits.maxLineBytes;
}

/**
 * Admit `line` (`lineBytes` raw octets), which ends in a `{octets}` literal
 * declaration, against the per-literal caps and the whole command's budget.
 * Called before the literal is invited or any of it buffered. On success the
 * segment is recorded; a zero-length literal has no octets to absorb, so its
 * empty value is recorded right away.
 */
export function admitLiteral(
	pending: PendingCommand | null,
	line: string,
	lineBytes: number,
	octets: number,
	limits: CommandLimits
): Admission {
	if (octets > limits.maxLiteralBytes || (limits.preAuth && octets > PRE_AUTH_LITERAL_BYTES)) {
		return { ok: false, reason: 'Literal too large' };
	}
	const next = pending ?? { segments: [], literals: [], bytes: 0 };
	const maxLiterals = limits.preAuth ? PRE_AUTH_COMMAND_LITERALS : MAX_COMMAND_LITERALS;
	if (
		next.bytes + lineBytes + octets > commandByteBudget(limits) ||
		next.segments.length >= maxLiterals
	) {
		return { ok: false, reason: 'Command too large' };
	}
	const token = line.match(/\{\d+\+?\}$/);
	next.segments.push(token ? line.slice(0, line.length - token[0].length) : line);
	next.bytes += lineBytes + octets;
	if (octets === 0) next.literals.push('');
	return { ok: true, pending: next };
}

/**
 * Whether a further `lineBytes` of segment text still fits the command's
 * budget. Checked on every buffered continuation line, finished or not, so an
 * unterminated tail cannot outgrow the budget while the pump waits for its CRLF.
 */
export function segmentFits(
	pending: PendingCommand,
	lineBytes: number,
	limits: CommandLimits
): boolean {
	return pending.bytes + lineBytes <= commandByteBudget(limits);
}

/** Admit the final segment (no trailing literal) of an assembled command. */
export function admitFinalSegment(
	pending: PendingCommand,
	line: string,
	lineBytes: number,
	limits: CommandLimits
): boolean {
	if (!segmentFits(pending, lineBytes, limits)) return false;
	pending.segments.push(line);
	pending.bytes += lineBytes;
	return true;
}
