/**
 * De-identify email addresses and subjects before they reach a process log.
 *
 * Process logs (Convex's function log, the sidecars' pino stdout) are not the
 * product: they get shipped to whatever aggregator the operator points at, are
 * read by people with no mail-content grant, and outlive the message they
 * describe. Everything here is about that pipe only — `auditLogs`, delivery
 * logs and anything else deliberately persisted for the UI is untouched.
 *
 * Why a hash and not a flat `[redacted]`: the single thing an operator does
 * with these lines is correlate them — "the message we bounced at the MTA is
 * the one Convex refused as a duplicate", "these 400 deferrals are all the same
 * recipient". A constant censor destroys that. A stable digest keeps it.
 *
 * Why the digest is unsalted, and what that does and does not buy: a per-process
 * salt would make the token unguessable, and would also make it useless — the
 * MTA line and the Convex line for the same recipient would no longer match,
 * and neither would two lines from either side of a restart. So the digest is a
 * pure function of the address. The honest consequence is that this is
 * de-identification, not anonymisation: an address is low-entropy, so anyone
 * holding both a log and a candidate list can confirm a guess by hashing it.
 * What it does buy is that the plaintext address is no longer *in* the log —
 * a leaked log file, a shared screenshot, a third-party aggregator index or a
 * support engineer reading along cannot read the correspondent off the line.
 *
 * The domain is kept in the clear on purpose. It is the part operators route on
 * (which tenant, which receiving provider, which forwarder) and it identifies a
 * host, not a person.
 */

/**
 * FNV-1a, 64-bit. Non-cryptographic and deliberately so: this runs on every
 * logged line in the MTA's hot path, must be synchronous (WebCrypto's digest is
 * not) and must work unchanged in a browser bundle, a Convex isolate and Bun.
 * The security property being claimed is "not readable", which preimage
 * resistance would not provide for an input this small anyway (see above); what
 * is actually needed is a wide, stable, cheap, collision-sparse token.
 */
function fnv1a64Hex(input: string): string {
	const prime = 0x100000001b3n;
	const mask = 0xffffffffffffffffn;
	let hash = 0xcbf29ce484222325n;
	for (let i = 0; i < input.length; i++) {
		hash ^= BigInt(input.charCodeAt(i));
		hash = (hash * prime) & mask;
	}
	return hash.toString(16).padStart(16, '0');
}

/** Digest width in hex chars. 12 → 48 bits, ~2e7 addresses before a 50% collision. */
const DIGEST_HEX = 12;

/** Stable token for an arbitrary string. */
function redactionDigest(value: string): string {
	return fnv1a64Hex(value).slice(0, DIGEST_HEX);
}

/**
 * `marcel@example.com` → `redacted-4f3a1c92b7d0@example.com`.
 *
 * The result is shaped like an address so structured log consumers that expect
 * one do not choke, and prefixed so nobody mistakes it for a deliverable one.
 * Input is lowercased and trimmed before hashing so the same mailbox written
 * three ways correlates to one token.
 *
 * A value with no `@` is not an address; it is hashed whole and returned as
 * `redacted-<digest>` rather than being guessed at.
 */
export function redactEmailAddress(address: string): string {
	const normalized = address.trim().toLowerCase();
	if (normalized.length === 0) return '';
	const at = normalized.lastIndexOf('@');
	const digest = redactionDigest(normalized);
	if (at <= 0 || at === normalized.length - 1) return `redacted-${digest}`;
	const domain = normalized.slice(at + 1);
	// From headers can contain display names/comments after the mailbox.
	// Only preserve a plain DNS name; hash malformed or decorated input whole.
	if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) return `redacted-${digest}`;
	return `redacted-${digest}@${domain}`;
}

/**
 * `Re: invoice 4012 overdue` → `[subject len=25 4f3a1c92b7d0]`.
 *
 * Subjects carry more than the address does — they are user-written prose and
 * routinely contain names, invoice numbers and case references — so nothing of
 * the text survives. The length is kept because it is the one property that
 * helps triage (empty subject, absurdly long subject) without describing
 * content, and the digest keeps the same subject correlatable across hops.
 */
export function redactSubject(subject: string): string {
	return `[subject len=${subject.length} ${redactionDigest(subject)}]`;
}

/**
 * Keys whose value is a correspondent address or a subject, wherever a
 * structured logger puts one. Each is listed at the top level and one level
 * down (`*.from`), which is where the sidecars' pino calls actually place them
 * (`logger.info({ err, rcptTo }, '…')`, `logger.warn({ job: { to } }, '…')`).
 * Deeper nesting is not covered — pino paths are static, and a guessed ladder of
 * wildcards would be a false promise; the gate and code review cover the rest.
 */
const REDACTED_LOG_KEYS = [
	'from',
	'to',
	'rcptTo',
	'mailFrom',
	'subject',
	'email',
	'recipient',
	'address',
	'sender',
] as const;

/** `redact.paths` for a pino logger: the keys above, at depth 0 and depth 1. */
export const LOG_REDACT_PATHS: string[] = [
	...REDACTED_LOG_KEYS,
	...REDACTED_LOG_KEYS.map((key) => `*.${key}`),
];

/**
 * `redact.censor` for a pino logger.
 *
 * A key from the list above does not guarantee the value is an address: the MTA
 * writes `{ to: 'deferred' }` state labels and `{ address: host }` through the
 * same names. So the rule is by value, not by key — a string containing `@` is
 * treated as an address, everything else under a non-subject key is left
 * readable. `subject` is unconditional: a subject is prose and has no shape to
 * test for.
 *
 * A non-string, non-array value under one of these keys is censored outright.
 * That is the conservative branch — an object sitting under `from` is far more
 * likely to be a parsed address than a config struct — and it is why the key
 * list stays narrow.
 */
export function logRedactCensor(value: unknown, path: readonly string[]): unknown {
	const key = path[path.length - 1];
	if (key === 'subject') {
		return typeof value === 'string' ? redactSubject(value) : '[redacted]';
	}
	if (typeof value === 'string') {
		return value.includes('@') ? redactEmailAddress(value) : value;
	}
	if (Array.isArray(value)) {
		return value.map((entry) => logRedactCensor(entry, path));
	}
	if (value === undefined || value === null) return value;
	return '[redacted]';
}

/** Severity names a projected line can carry. */
export type ExportedLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * One process-log line as it may leave the box in a support bundle.
 *
 * Every field is either copied from an allowlisted key whose value passed a
 * shape check, or computed (length, digest, counts). The free text of the line
 * never survives: `msgDigest` and `len` stand in for it, so the same message
 * repeated 500 times is still visible as one digest.
 */
export interface ExportedLogLine {
	/** How the line was read: a JSON object, a JSON object inside text, or plain text. */
	format: 'json' | 'embedded-json' | 'text';
	level?: ExportedLogLevel;
	/** A dotted `logEvent` name (`delivery.dispatch.accepted`). */
	event?: string;
	/** The emitting process's own name (pino `base.service`, e.g. `owlat-mta`). */
	service?: string;
	outcome?: string;
	category?: string;
	durationMs?: number;
	/** An HTTP status the line reports (100-599). */
	httpStatus?: number;
	/** The error's class name (`TypeError`). */
	errType?: string;
	/** A system error code (`ECONNREFUSED`, `ERR_INVALID_URL`). */
	errCode?: string;
	/** Length of the original line, in UTF-16 code units. */
	len: number;
	/** Digest of the message text (`msg`, or the whole line for text). */
	msgDigest: string;
	/** How many top-level keys of a JSON line were dropped. */
	dropped?: number;
}

const PINO_LEVELS: Record<number, ExportedLogLevel> = {
	10: 'trace',
	20: 'debug',
	30: 'info',
	40: 'warn',
	50: 'error',
	60: 'fatal',
};

const LEVEL_NAMES: Record<string, ExportedLogLevel> = {
	trace: 'trace',
	debug: 'debug',
	info: 'info',
	log: 'info',
	warn: 'warn',
	warning: 'warn',
	error: 'error',
	err: 'error',
	fatal: 'fatal',
	panic: 'fatal',
	critical: 'fatal',
};

const EXPORT_EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const EXPORT_TOKEN = /^[a-z][a-z0-9_.-]{0,39}$/;
const EXPORT_ERR_TYPE = /^[A-Z][A-Za-z0-9]{0,63}$/;
const EXPORT_ERR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;
/** A plain-text line's leading level word, after an optional timestamp of its own. */
const TEXT_LEVEL = /^\s*(?:\S*\d{2}:\d{2}:\d{2}\S*\s+)?\[?([A-Za-z]{3,8})\]?[\s:]/;

/** Keys {@link projectLogLineForExport} reads, so they do not count as dropped. */
const PROJECTED_KEYS = new Set([
	'level',
	'severity',
	'event',
	'service',
	'outcome',
	'category',
	'durationMs',
	'statusCode',
	'status',
	'err',
	'error',
	'msg',
	'message',
]);

function levelOf(value: unknown): ExportedLogLevel | undefined {
	if (typeof value === 'number') return PINO_LEVELS[value];
	if (typeof value === 'string') return LEVEL_NAMES[value.toLowerCase()];
	return undefined;
}

function matching(value: unknown, pattern: RegExp, maxLength = 128): string | undefined {
	return typeof value === 'string' && value.length <= maxLength && pattern.test(value)
		? value
		: undefined;
}

function parseObject(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function projectObject(
	record: Record<string, unknown>,
	line: string,
	format: 'json' | 'embedded-json'
): ExportedLogLine {
	const message =
		typeof record['msg'] === 'string'
			? record['msg']
			: typeof record['message'] === 'string'
				? record['message']
				: line;
	const out: ExportedLogLine = { format, len: line.length, msgDigest: redactionDigest(message) };
	const level = levelOf(record['level']) ?? levelOf(record['severity']);
	if (level) out.level = level;
	const event = matching(record['event'], EXPORT_EVENT_NAME);
	if (event) out.event = event;
	const service = matching(record['service'], EXPORT_TOKEN);
	if (service) out.service = service;
	const outcome = matching(record['outcome'], EXPORT_TOKEN);
	if (outcome) out.outcome = outcome;
	const category = matching(record['category'], EXPORT_TOKEN);
	if (category) out.category = category;
	const duration = record['durationMs'];
	if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
		out.durationMs = duration;
	}
	for (const key of ['statusCode', 'status']) {
		const status = record[key];
		if (Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599) {
			out.httpStatus = status as number;
			break;
		}
	}
	const err = record['err'] ?? record['error'];
	if (typeof err === 'object' && err !== null && !Array.isArray(err)) {
		const errRecord = err as Record<string, unknown>;
		const errType = matching(errRecord['type'], EXPORT_ERR_TYPE);
		if (errType) out.errType = errType;
		const errCode = matching(errRecord['code'], EXPORT_ERR_CODE);
		if (errCode) out.errCode = errCode;
	}
	const dropped = Object.keys(record).filter((key) => !PROJECTED_KEYS.has(key)).length;
	if (dropped > 0) out.dropped = dropped;
	return out;
}

/**
 * Project one process-log line onto {@link ExportedLogLine} for a support
 * bundle that leaves the operator's box.
 *
 * Unlike the pino censor above, this is an allowlist: a mail log carries
 * addresses, subjects, hostnames and provider error prose under keys nobody can
 * enumerate, so a key list of what to hide would always miss one. Only the
 * fixed keys read here survive, and only when their value has the shape the
 * key promises (a dotted event name, a lowercase token, a number in range).
 * Messages, stacks, nested objects, `detail` and every unknown key are dropped;
 * plain-text lines keep at most their leading level word.
 */
export function projectLogLineForExport(line: string): ExportedLogLine {
	const trimmed = line.trim();
	if (trimmed.startsWith('{')) {
		const record = parseObject(trimmed);
		if (record) return projectObject(record, line, 'json');
	}
	const open = trimmed.indexOf('{');
	const close = trimmed.lastIndexOf('}');
	if (open > 0 && close > open) {
		const record = parseObject(trimmed.slice(open, close + 1));
		if (record && (typeof record['event'] === 'string' || record['level'] !== undefined)) {
			return projectObject(record, line, 'embedded-json');
		}
	}
	const out: ExportedLogLine = {
		format: 'text',
		len: line.length,
		msgDigest: redactionDigest(line),
	};
	const level = levelOf(TEXT_LEVEL.exec(line)?.[1]);
	if (level) out.level = level;
	return out;
}
