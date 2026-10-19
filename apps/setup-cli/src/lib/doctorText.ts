/**
 * What `owlat-setup doctor` may print. The one owner of that decision.
 *
 * Every doctor message is a {@link DoctorText} built with the {@link doctorText}
 * tag, so each piece of it says where it came from:
 *
 * - the template's own literal text, and anything wrapped in {@link trusted}
 *   (env key names, paths, copy from a shared catalog), is code-owned and
 *   printed as written. Redaction never touches it, so a secret that happens to
 *   equal `SMTP` cannot turn `SMTP_RELAY_HOST` into `[redacted]_RELAY_HOST`;
 * - a configured value is interpolated only through a sanitizer:
 *   {@link envValue} prints it for an allow-listed non-secret key and
 *   `[redacted]` for every other key, and {@link urlValue} prints
 *   `scheme://host[:port]/path` and never userinfo, query or fragment;
 * - any other interpolated string is runtime data (the MTA's answer, docker's
 *   status line, an error message).
 *
 * Everything that is not code-owned then passes the known-secret pass of
 * {@link createDoctorRedactor} as defence in depth: every secret from `.env`,
 * in raw, URL-encoded and base64 form, with no length exemption.
 */

import type { EnvMap } from './env';

export const REDACTED = '[redacted]';

interface DoctorTextPart {
	text: string;
	/** Code-owned: printed as written, never redacted. */
	trusted: boolean;
}

/** An interpolation the {@link doctorText} tag treats as code-owned. */
interface Trusted {
	readonly trustedText: string;
}

export class DoctorText {
	constructor(readonly parts: readonly DoctorTextPart[]) {}

	/** Render with every untrusted part passed through `redact`. */
	render(redact: (text: string) => string): string {
		return this.parts.map((part) => (part.trusted ? part.text : redact(part.text))).join('');
	}

	/** The sanitized text without the known-secret pass (no `.env` at hand). */
	toString(): string {
		return this.render((text) => text);
	}
}

/** Code-owned text or a trusted identifier: an env key name, a path, catalog copy. */
export function trusted(text: string): Trusted {
	return { trustedText: text };
}

/**
 * Configured values doctor may echo. Everything else prints as `[redacted]`:
 * a key not on this list may hold a credential, whatever its name says.
 */
const DISPLAYABLE_ENV_KEYS: ReadonlySet<string> = new Set(['EMAIL_PROVIDER', 'OWLAT_VERSION']);

/** A configured value: shown only for an allow-listed non-secret key. */
export function envValue(key: string, value: string): string {
	return DISPLAYABLE_ENV_KEYS.has(key) ? value : REDACTED;
}

/**
 * A URL without the parts that carry credentials: `scheme://host[:port]/path`.
 * An unparseable value prints as `[redacted]`, since nothing about it is known to be safe.
 */
export function urlValue(raw: string): string {
	try {
		const url = new URL(raw);
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return REDACTED;
	}
}

/**
 * Tag for every doctor message. Literal text and {@link trusted} values are
 * code-owned; numbers are counts the code computed; every other string is
 * untrusted and will pass the known-secret redaction.
 */
export function doctorText(
	strings: TemplateStringsArray,
	...values: Array<string | number | Trusted>
): DoctorText {
	const parts: DoctorTextPart[] = [];
	for (const [index, literal] of strings.entries()) {
		if (literal) parts.push({ text: literal, trusted: true });
		if (index >= values.length) continue;
		const value = values[index]!;
		if (typeof value === 'number') parts.push({ text: String(value), trusted: true });
		else if (typeof value === 'string') parts.push({ text: value, trusted: false });
		else parts.push({ text: value.trustedText, trusted: true });
	}
	return new DoctorText(parts);
}

/** Env keys whose values are credentials (a superset of `env --show`'s masking). */
const SECRET_KEY = /(^|_)(KEY|SECRET|PASSWORD|TOKEN|CREDENTIALS?)(_|$)/;

/** The credential-bearing parts of a configured URL: password (or a lone username), query values, fragment. */
function urlSecrets(value: string): string[] {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return [];
	}
	// A username beside a password is an account name; alone (`https://TOKEN@host`)
	// it is the credential.
	const encoded = [url.password || url.username, url.hash.slice(1)];
	// `URL` keeps userinfo and fragment percent-encoded; the raw text may not be.
	const decoded = encoded.flatMap((secret) => {
		try {
			return [decodeURIComponent(secret)];
		} catch {
			// Not valid percent-encoding: the encoded form is all there is.
			return [];
		}
	});
	return [...encoded, ...decoded, ...url.searchParams.values()];
}

/** Every printed form a secret could take: raw, URL-encoded (either hex case) and base64. */
function secretForms(secret: string): string[] {
	const encoded = encodeURIComponent(secret);
	const base64 = Buffer.from(secret).toString('base64');
	return [
		secret,
		encoded,
		encoded.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
		base64,
		base64.replace(/=+$/, ''),
		Buffer.from(secret).toString('base64url'),
	];
}

/**
 * The known-secret pass for one doctor run: replaces every form of every
 * secret-keyed `.env` value, and of every credential part of a configured URL,
 * in untrusted text. No length exemption: an over-redacted runtime detail is
 * a lesser failure than a printed credential, and code-owned text is out of
 * its reach.
 */
export function createDoctorRedactor(env: EnvMap): (text: string) => string {
	const secrets = new Set<string>();
	for (const [key, value] of Object.entries(env)) {
		const raw = SECRET_KEY.test(key) ? [value, ...urlSecrets(value)] : urlSecrets(value);
		for (const secret of raw) {
			if (!secret) continue;
			for (const form of secretForms(secret)) if (form) secrets.add(form);
		}
	}
	if (secrets.size === 0) return (text) => text;
	// One pass, longest first: a secret that contains another is replaced whole,
	// and a short secret cannot match inside an earlier `[redacted]`.
	const pattern = new RegExp(
		[...secrets]
			.sort((a, b) => b.length - a.length)
			.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.join('|'),
		'g'
	);
	return (text) => text.replace(pattern, REDACTED);
}
