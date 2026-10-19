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
 * {@link createDoctorRedactor} as defence in depth: every secret from `.env`
 * is masked in its raw, URL-encoded and base64 forms, with no length
 * exemption, and a part with any percent-escape left outside those masks is
 * dropped whole.
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
 * code-owned; numbers are counts the code computed; a nested `DoctorText`
 * keeps its own parts; every other string is untrusted and will pass the
 * known-secret redaction. It also fits the shared evaluators' `MessageFormat`
 * hook (`@owlat/shared/containerHealth`), so their literal copy stays
 * code-owned and only the docker and `.env` values they interpolate are not.
 */
export function doctorText(
	strings: TemplateStringsArray,
	...values: Array<string | number | Trusted | DoctorText>
): DoctorText {
	const parts: DoctorTextPart[] = [];
	for (const [index, literal] of strings.entries()) {
		if (literal) parts.push({ text: literal, trusted: true });
		if (index >= values.length) continue;
		const value = values[index]!;
		if (typeof value === 'number') parts.push({ text: String(value), trusted: true });
		else if (typeof value === 'string') parts.push({ text: value, trusted: false });
		else if (value instanceof DoctorText) parts.push(...value.parts);
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

/**
 * Every printed form of a secret the exact pass masks: raw, URL-encoded (as
 * `encodeURIComponent` and as a form value, `+` for a space) and base64
 * (padded, unpadded, url-safe). Matched case-insensitively, which also covers
 * either hex case in an escape.
 */
function secretForms(secret: string): string[] {
	const encoded = encodeURIComponent(secret);
	const base64 = Buffer.from(secret).toString('base64');
	return [
		secret,
		encoded,
		encoded.replace(/%20/g, '+'),
		new URLSearchParams([['', secret]]).toString().slice(1),
		base64,
		base64.replace(/=+$/, ''),
		Buffer.from(secret).toString('base64url'),
	];
}

/** A half-open `[start, end)` span of the input. */
type Span = [number, number];

/** Every case-insensitive occurrence of every form, overlapping ones included. */
function exactSpans(text: string, forms: readonly RegExp[]): Span[] {
	const spans: Span[] = [];
	for (const form of forms) {
		form.lastIndex = 0;
		for (let match = form.exec(text); match; match = form.exec(text)) {
			spans.push([match.index, match.index + match[0].length]);
			form.lastIndex = match.index + 1;
		}
	}
	return spans;
}

/** Sorted, merged spans: overlapping or touching spans become one. */
function mergeSpans(spans: readonly Span[]): Span[] {
	const merged: Span[] = [];
	for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

/** A percent-escape, the one thing every deeper or partial URL encoding of a secret contains. */
const PERCENT_ESCAPE = /%[0-9a-f]{2}/i;

/**
 * The known-secret pass for one doctor run, over untrusted text only.
 *
 * Step 1, the exact pass: every printed form of every secret (see
 * {@link secretForms}) is located as positions in the input, and the union is
 * masked in the output. Positions, not marker characters: nothing is spliced
 * into the text, so a literal `[redacted]` in runtime text is ordinary text.
 *
 * Step 2, the guarantee, with no decoding: if the text outside the masks,
 * joined as a reader would join it after deleting the markers, contains any
 * percent-escape, the WHOLE part becomes `[redacted]`. A secret the exact pass
 * did not mask can only hide in an encoding, and every repeated, partial or
 * odd percent-encoding of it (double encoding, every byte escaped, escapes
 * split around another secret's mask, an invalid `%FF` in front) carries
 * escapes. The cost is readability: a runtime error whose URL holds an
 * unrelated `%20` loses its detail too. For doctor output that is the right
 * trade.
 *
 * Secrets are every secret-keyed `.env` value and every credential part of a
 * configured URL. No length exemption: code-owned text is out of reach, so
 * over-redaction can only cost runtime detail.
 */
export function createDoctorRedactor(env: EnvMap): (text: string) => string {
	const forms = new Set<string>();
	for (const [key, value] of Object.entries(env)) {
		const raw = SECRET_KEY.test(key) ? [value, ...urlSecrets(value)] : urlSecrets(value);
		for (const secret of raw) {
			if (secret) for (const form of secretForms(secret)) if (form) forms.add(form.toLowerCase());
		}
	}
	if (forms.size === 0) return (text) => text;
	const patterns = [...forms].map(
		(form) => new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
	);
	return (text) => {
		const spans = mergeSpans(exactSpans(text, patterns));
		let visible = '';
		let out = '';
		let from = 0;
		for (const [start, end] of spans) {
			visible += text.slice(from, start);
			out += text.slice(from, start) + REDACTED;
			from = end;
		}
		visible += text.slice(from);
		if (PERCENT_ESCAPE.test(visible)) return REDACTED;
		return out + text.slice(from);
	};
}
