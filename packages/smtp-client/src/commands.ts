/**
 * SMTP command serializers and the EHLO capability-table parser.
 *
 * Every parameterised field is guarded against CRLF injection BEFORE any bytes
 * are produced: a newline smuggled into an address or an ESMTP parameter would
 * let a caller inject an out-of-band command, so we throw instead of emitting.
 * The serializers are pure string builders — no sockets, no I/O.
 */

import type { SmtpReply } from './reply';

/** Thrown when a command field contains a CR or LF (a wire-injection attempt). */
export class SmtpCommandInjectionError extends Error {
	readonly field: string;
	constructor(field: string, value: string) {
		super(
			`refusing to serialize SMTP command: field ${field} contains a CR/LF (${JSON.stringify(value)})`
		);
		this.name = 'SmtpCommandInjectionError';
		this.field = field;
		Object.setPrototypeOf(this, SmtpCommandInjectionError.prototype);
	}
}

const CRLF = '\r\n';

function assertNoCrlf(field: string, value: string): void {
	if (value.includes('\r') || value.includes('\n')) {
		throw new SmtpCommandInjectionError(field, value);
	}
}

function assertParams(params: readonly string[]): void {
	for (let i = 0; i < params.length; i++) {
		assertNoCrlf(`param[${i}]`, params[i] as string);
	}
}

function withParams(head: string, params: readonly string[]): string {
	if (params.length === 0) {
		return head + CRLF;
	}
	return `${head} ${params.join(' ')}${CRLF}`;
}

export function serializeEhlo(domain: string): string {
	assertNoCrlf('EHLO domain', domain);
	return `EHLO ${domain}${CRLF}`;
}

export function serializeHelo(domain: string): string {
	assertNoCrlf('HELO domain', domain);
	return `HELO ${domain}${CRLF}`;
}

/**
 * `MAIL FROM:<address>` with optional ESMTP parameters (e.g. `SIZE=1024`).
 * An empty address serializes the null return path `<>`.
 */
export function serializeMailFrom(address: string, params: readonly string[] = []): string {
	assertNoCrlf('MAIL FROM address', address);
	assertParams(params);
	return withParams(`MAIL FROM:<${address}>`, params);
}

/** `RCPT TO:<address>` with optional ESMTP parameters (e.g. `NOTIFY=NEVER`). */
export function serializeRcptTo(address: string, params: readonly string[] = []): string {
	assertNoCrlf('RCPT TO address', address);
	assertParams(params);
	return withParams(`RCPT TO:<${address}>`, params);
}

export function serializeData(): string {
	return `DATA${CRLF}`;
}

export function serializeRset(): string {
	return `RSET${CRLF}`;
}

export function serializeQuit(): string {
	return `QUIT${CRLF}`;
}

export function serializeStartTls(): string {
	return `STARTTLS${CRLF}`;
}

export function serializeNoop(): string {
	return `NOOP${CRLF}`;
}

/**
 * `AUTH <mechanism>` optionally with an initial response token. The mechanism
 * and token are guarded — an injected CRLF here would be an auth-bypass vector.
 */
export function serializeAuth(mechanism: string, initialResponse?: string): string {
	assertNoCrlf('AUTH mechanism', mechanism);
	if (initialResponse === undefined) {
		return `AUTH ${mechanism}${CRLF}`;
	}
	assertNoCrlf('AUTH initial-response', initialResponse);
	return `AUTH ${mechanism} ${initialResponse}${CRLF}`;
}

/** A single line of an SASL continuation exchange (base64 or `*` cancel). */
export function serializeAuthContinuation(token: string): string {
	assertNoCrlf('AUTH continuation', token);
	return `${token}${CRLF}`;
}

/**
 * The capabilities advertised by a server in its EHLO response, parsed from the
 * continuation lines that follow the greeting line. Keyword lookups are
 * case-insensitive (keywords are uppercased on ingest).
 */
export interface EhloCapabilities {
	/** Every capability keyword -> its argument tokens (keyword uppercased). */
	raw: Map<string, string[]>;
	/** The advertised maximum message size (`SIZE` argument), if a number. */
	size?: number;
	/** Whether `STARTTLS` was advertised. */
	startTls: boolean;
	/** SASL mechanisms from the `AUTH` line, uppercased. */
	authMechanisms: Set<string>;
	/** Whether `PIPELINING` (RFC 2920) was advertised. */
	pipelining: boolean;
	/** Whether `SMTPUTF8` (RFC 6531) was advertised. */
	smtpUtf8: boolean;
	/** Whether `8BITMIME` was advertised. */
	eightBitMime: boolean;
	/** Whether `ENHANCEDSTATUSCODES` (RFC 2034) was advertised. */
	enhancedStatusCodes: boolean;
}

/** `true` if the server advertised the given (case-insensitive) capability. */
export function hasCapability(caps: EhloCapabilities, keyword: string): boolean {
	return caps.raw.has(keyword.toUpperCase());
}

/**
 * Parse an EHLO {@link SmtpReply} into a capability table. The FIRST reply line
 * is the greeting/hostname line and is not a capability; every subsequent line
 * is a `KEYWORD [args...]` entry.
 */
export function parseEhloCapabilities(reply: SmtpReply): EhloCapabilities {
	const raw = new Map<string, string[]>();
	const authMechanisms = new Set<string>();
	let size: number | undefined;

	// Skip line[0] — it is the greeting/domain line, not a capability.
	for (let i = 1; i < reply.lines.length; i++) {
		const line = (reply.lines[i] ?? '').trim();
		if (line === '') {
			continue;
		}
		// Old-style `AUTH=LOGIN PLAIN` collapses the `=` into the separator.
		const tokens = line.split(/[ \t=]+/).filter((t) => t !== '');
		const keyword = (tokens[0] ?? '').toUpperCase();
		if (keyword === '') {
			continue;
		}
		const args = tokens.slice(1);
		raw.set(keyword, args);

		if (keyword === 'AUTH') {
			for (const mech of args) {
				authMechanisms.add(mech.toUpperCase());
			}
		} else if (keyword === 'SIZE') {
			const first = args[0];
			if (first !== undefined) {
				const parsed = Number.parseInt(first, 10);
				if (Number.isFinite(parsed)) {
					size = parsed;
				}
			}
		}
	}

	const caps: EhloCapabilities = {
		raw,
		startTls: raw.has('STARTTLS'),
		authMechanisms,
		pipelining: raw.has('PIPELINING'),
		smtpUtf8: raw.has('SMTPUTF8'),
		eightBitMime: raw.has('8BITMIME'),
		enhancedStatusCodes: raw.has('ENHANCEDSTATUSCODES'),
	};
	if (size !== undefined) {
		caps.size = size;
	}
	return caps;
}
