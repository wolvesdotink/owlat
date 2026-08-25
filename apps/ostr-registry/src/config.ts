/**
 * Environment configuration for the registry node (plan §12.1).
 *
 * Everything the process needs is read here, once, at startup, and validated
 * to the point where the rest of the code can treat it as facts: a port is a
 * port, a signing key is 32 raw bytes, an origin is a domain. A misconfigured
 * node must fail while an operator is watching it start, not at 03:00 when the
 * first refresh tries to sign a zone.
 *
 * Two keys are the whole security posture of the node and neither has a
 * default: the log's signing key and the aggregator's. They are separate
 * because they say different things — one commits to "this log contains these
 * leaves", the other to "this aggregator computed these scores" — and a
 * deployment that shares one key between them makes the two claims
 * indistinguishable to a monitor.
 */
import { isIP } from 'node:net';
import { isEd25519Key, isFqdn } from '@owlat/ostr-core';
import { parseBootstrapObservers, type BootstrapObserver } from './keys/index.js';

/**
 * The `_ostr` zone this node publishes under when the operator names none.
 * `.invalid` is reserved by RFC 2606 and can never resolve, so an unconfigured
 * node publishes a zone that is obviously a placeholder instead of quietly
 * claiming someone's real name.
 */
export const DEFAULT_ZONE_ORIGIN = 'ostr.invalid';

/** pino's level names, plus `silent`. The only values `LOG_LEVEL` may take. */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface OstrRegistryConfig {
	/** `OSTR_REGISTRY_PORT` (default 3300). 0 asks the OS for an ephemeral port. */
	port: number;
	/** `OSTR_REGISTRY_LISTEN` (default 0.0.0.0) — the bind address: an IP literal or `localhost`. */
	listenAddress: string;
	/** `OSTR_DB_DIR` (default ./.data): directory holding `log.sqlite` and `scores.sqlite`. */
	dbDir: string;
	/** `OSTR_LOG_ID` (required): this log's stable identifier, signed into every head and promise. */
	logId: string;
	/** `OSTR_LOG_PRIVATE_KEY` (required): raw 32-byte ed25519 key, base64 — the log's signing key. */
	logPrivateKeyBase64: string;
	/** `OSTR_AGGREGATOR_PRIVATE_KEY` (required): raw 32-byte ed25519 key, base64 — signs snapshots. */
	aggregatorPrivateKeyBase64: string;
	/** `OSTR_ZONE_ORIGIN` (default {@link DEFAULT_ZONE_ORIGIN}): apex of the generated query zone. */
	zoneOrigin: string;
	/** `OSTR_REF_BASE_URL` (default `https://<origin>/s`): evidence-page base in every TXT answer. */
	refBaseUrl: string;
	/** `OSTR_STH_INTERVAL_SECONDS` (default 3600): how often a signed tree head is published. */
	sthIntervalSeconds: number;
	/** `OSTR_REFRESH_INTERVAL_SECONDS` (default 3600): how often scores, zone and snapshot recompute. */
	refreshIntervalSeconds: number;
	/** `OSTR_MMD_SECONDS` (default 86400): the published maximum merge delay every promise states. */
	mmdSeconds: number;
	/**
	 * `OSTR_SUBMIT_RATE_PER_MINUTE` (optional): a ceiling on accepted submissions
	 * per minute, node-wide. Unset means no limit — spec 08 §8.2 permits limits
	 * and requires that they be published, but what they are is the operator's
	 * decision, so this layer states no default policy.
	 */
	submitRatePerMinute: number | null;
	/** `LOG_LEVEL` (default `info`): pino's level for this process's own logging. */
	logLevel: LogLevel;
	/**
	 * `OSTR_BOOTSTRAP_OBSERVERS` (optional): the §4.2 published allowlist. Unset
	 * means open submission — any observer publishing an `_ostr` key. Set means
	 * ONLY these observers are accepted; their keys still come from DNS unless
	 * an entry pins one as `domain=<key>`.
	 */
	bootstrapObservers: BootstrapObserver[] | null;
}

/** The subset of `process.env` this module reads. */
export type Environment = Readonly<Record<string, string | undefined>>;

function optional(env: Environment, key: string): string | undefined {
	const value = env[key];
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

function required(env: Environment, key: string): string {
	const value = optional(env, key);
	if (value === undefined) throw new Error(`${key} is required`);
	return value;
}

/** A whole number in `[min, max]`, or a stated failure — never a silent NaN. */
function integer(
	env: Environment,
	key: string,
	fallback: number,
	min: number,
	max: number
): number {
	const raw = optional(env, key);
	if (raw === undefined) return fallback;
	// `parseInt` would read "8080abc" as 8080 and "" as NaN; Number() is exact
	// about the whole string, which is what a configured value should be.
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${key} must be an integer between ${min} and ${max}, got "${raw}"`);
	}
	return value;
}

/**
 * A raw 32-byte ed25519 private key in base64 — the form `@owlat/ostr-core`
 * signs with. `isEd25519Key` is the right predicate despite its name: an
 * ed25519 private key is a 32-byte seed, the same size and encoding as a public
 * key, and this is the only shape `ed25519Sign` accepts. What it cannot catch
 * is a public key pasted where a private one belongs — every 32-byte value is a
 * syntactically valid seed — so the first signature is what proves the pair.
 */
function signingKey(env: Environment, key: string): string {
	const value = required(env, key);
	if (!isEd25519Key(value)) {
		throw new Error(`${key} must be a raw 32-byte ed25519 private key in base64`);
	}
	return value;
}

/**
 * A bind address: an IPv4/IPv6 literal, or `localhost`.
 *
 * Anything else — a hostname with an A record, a typo, a URL — is refused here
 * rather than surfacing as an opaque `getaddrinfo` rejection out of `listen()`,
 * which happens after both stores are open and a full refresh has run.
 */
function bindAddress(env: Environment, key: string, fallback: string): string {
	const value = optional(env, key) ?? fallback;
	if (isIP(value) === 0 && value !== 'localhost') {
		throw new Error(`${key} must be an IP literal or "localhost", got "${value}"`);
	}
	return value;
}

/** pino's level, or a stated failure — a typo'd level must not silence a node. */
function logLevel(env: Environment): LogLevel {
	const value = optional(env, 'LOG_LEVEL')?.toLowerCase() ?? 'info';
	const level = LOG_LEVELS.find((candidate) => candidate === value);
	if (level === undefined) {
		throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`);
	}
	return level;
}

/**
 * Any C0 control or DEL. Checked as code points rather than with a regex so the
 * intent reads without a lint suppression: these are the characters that end a
 * zone-file line or a quoted character-string.
 */
function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** Seconds in `[1, 31 days]`: a cadence, not a timestamp and not a typo'd zero. */
const MAX_INTERVAL_SECONDS = 2_678_400;

export function loadConfig(env: Environment = process.env): OstrRegistryConfig {
	const logId = required(env, 'OSTR_LOG_ID');
	if (/\s/.test(logId) || logId.length > 255) {
		throw new Error('OSTR_LOG_ID must be a short identifier without whitespace');
	}

	const zoneOrigin = (optional(env, 'OSTR_ZONE_ORIGIN') ?? DEFAULT_ZONE_ORIGIN).toLowerCase();
	if (!isFqdn(zoneOrigin)) {
		throw new Error(`OSTR_ZONE_ORIGIN must be a domain name, got "${zoneOrigin}"`);
	}

	// Interpolated into every published TXT answer, so it is checked here as
	// well as by the zone renderer: a broken evidence link is served to every
	// consumer of the zone until the next refresh.
	//
	// CONTROL CHARACTERS ARE REFUSED, NOT SANITIZED. `new URL()` silently strips
	// CR, LF and TAB while parsing, so a value carrying them would validate and
	// then be published verbatim — a newline inside a TXT record's quoted string
	// ends the record and lets the rest of the value be read as further zone
	// lines, which is an attacker-chosen NS or A record in this node's zone.
	const rawRefBaseUrl = optional(env, 'OSTR_REF_BASE_URL') ?? `https://${zoneOrigin}/s`;
	if (hasControlCharacter(rawRefBaseUrl)) {
		throw new Error('OSTR_REF_BASE_URL must not contain control characters');
	}
	let refUrl: URL;
	try {
		refUrl = new URL(rawRefBaseUrl);
	} catch {
		throw new Error(`OSTR_REF_BASE_URL must be an absolute URL, got "${rawRefBaseUrl}"`);
	}
	if (refUrl.protocol !== 'https:' && refUrl.protocol !== 'http:') {
		throw new Error(`OSTR_REF_BASE_URL must be http(s), got "${rawRefBaseUrl}"`);
	}

	// The parsed, percent-encoded form — never the raw string. Everything
	// downstream interpolates this into zone text and into HTML links, and
	// `href` is the only spelling of it that has been through a parser.
	const refBaseUrl = refUrl.href.replace(/\/+$/, '');

	// Present-but-blank is a configuration error, not open submission: an unset
	// compose interpolation (`OSTR_BOOTSTRAP_OBSERVERS=${SEED_OBSERVERS}`)
	// arrives as an empty string, and turning the §4.2 allowlist off without a
	// word is the one failure mode this variable must not have. Only a genuinely
	// absent variable means open submission.
	const bootstrap = env['OSTR_BOOTSTRAP_OBSERVERS'];

	const sthIntervalSeconds = integer(
		env,
		'OSTR_STH_INTERVAL_SECONDS',
		3600,
		1,
		MAX_INTERVAL_SECONDS
	);
	const mmdSeconds = integer(env, 'OSTR_MMD_SECONDS', 86_400, 1, MAX_INTERVAL_SECONDS);
	// A promise states the MMD; a leaf can only become covered at the head
	// cadence. Publishing less often than the delay promised means every promise
	// this node issues is one it structurally cannot keep, and a monitor sees a
	// log in permanent MMD violation from the first submission.
	if (sthIntervalSeconds > mmdSeconds) {
		throw new Error(
			`OSTR_STH_INTERVAL_SECONDS (${sthIntervalSeconds}) must not exceed OSTR_MMD_SECONDS (${mmdSeconds}): a head published less often than the promised merge delay breaks every inclusion promise`
		);
	}

	return {
		port: integer(env, 'OSTR_REGISTRY_PORT', 3300, 0, 65_535),
		listenAddress: bindAddress(env, 'OSTR_REGISTRY_LISTEN', '0.0.0.0'),
		dbDir: optional(env, 'OSTR_DB_DIR') ?? './.data',
		logId,
		logPrivateKeyBase64: signingKey(env, 'OSTR_LOG_PRIVATE_KEY'),
		aggregatorPrivateKeyBase64: signingKey(env, 'OSTR_AGGREGATOR_PRIVATE_KEY'),
		zoneOrigin,
		refBaseUrl,
		sthIntervalSeconds,
		refreshIntervalSeconds: integer(
			env,
			'OSTR_REFRESH_INTERVAL_SECONDS',
			3600,
			1,
			MAX_INTERVAL_SECONDS
		),
		mmdSeconds,
		submitRatePerMinute:
			optional(env, 'OSTR_SUBMIT_RATE_PER_MINUTE') === undefined
				? null
				: integer(env, 'OSTR_SUBMIT_RATE_PER_MINUTE', 0, 1, 1_000_000),
		logLevel: logLevel(env),
		bootstrapObservers: bootstrap === undefined ? null : parseBootstrapObservers(bootstrap),
	};
}
