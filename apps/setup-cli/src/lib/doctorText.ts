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
 * {@link createDoctorRedactor} as defence in depth: a part holding any `%` is
 * withheld whole, and every secret from `.env` is masked in its raw,
 * case-varied, form-encoded and base64 forms, with no length exemption.
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

	/**
	 * Only the code-owned text: each run of runtime parts becomes one
	 * `[redacted]`. For output that leaves the install (a support bundle), where
	 * runtime text such as an MTA headline can carry personal data that no
	 * secret list knows about.
	 */
	codeOwned(): string {
		return withheld(this.parts);
	}
}

/**
 * Code-owned text or a trusted identifier: an env key name, a fixed path,
 * catalog copy. Never anything built from operator input or runtime data: a
 * path under the configured install directory carries that directory's name.
 */
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
 * The printed forms of a secret, each kept exactly as computed: the original
 * is never replaced by a case-mapped copy, because a lower-cased form need
 * not match its original back (`İ` lower-cases to two code points).
 * `textual` is masked case-insensitively (simple case folding): raw,
 * `encodeURIComponent` and the form-encoded variants (`+` for a space). Case
 * variants simple folding cannot reach (`ß` against `SS`) are caught by the
 * fold check in {@link createDoctorRedactor}. `base64` is matched exactly:
 * padded, unpadded and url-safe.
 */
function secretForms(secret: string): { textual: string[]; base64: string[] } {
	const encoded = encodeURIComponent(secret);
	const base64 = Buffer.from(secret).toString('base64');
	return {
		textual: [
			secret,
			encoded,
			encoded.replace(/%20/g, '+'),
			new URLSearchParams([['', secret]]).toString().slice(1),
		],
		base64: [base64, base64.replace(/=+$/, ''), Buffer.from(secret).toString('base64url')],
	};
}

/** A pattern for one form, from its regex-escaped source. */
function formPattern(form: string, flags: string): RegExp {
	return new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
}

/** A half-open `[start, end)` span of the input. */
type Span = [number, number];

/** Every occurrence of every pattern, overlapping ones included. */
function exactSpans(text: string, patterns: readonly RegExp[]): Span[] {
	const spans: Span[] = [];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
			spans.push([match.index, match.index + match[0].length]);
			pattern.lastIndex = match.index + 1;
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

const WHITESPACE = /\s+/gu;

/**
 * Full case folding after compatibility normalisation, one code point at a
 * time. NFKC unifies composed and decomposed accents and compatibility forms.
 * Each code point is then mapped on its own, lower, upper, then lower: on its
 * own so no context rule can apply (a whole-string lower-case turns a final
 * `Σ` into `ς` but a mid-word one into `σ`), and lower first so the capital
 * `ẞ` (already upper case) ends as `ss` like `ß` and `SS`. NFKC runs again at
 * the end, because case mapping can produce decomposed sequences (`ǰ`
 * upper-cases to `J` + U+030C).
 */
function fold(text: string): string {
	return [...text.normalize('NFKC')]
		.map((char) => char.toLowerCase().toUpperCase().toLowerCase())
		.join('')
		.normalize('NFKC');
}

/**
 * The folded text with all whitespace stripped, in that order: NFKC can
 * introduce whitespace (`¨` becomes a space plus U+0308), so stripping first
 * would leave it on one side only. The same function serves the secret and
 * the message.
 */
function compact(text: string): string {
	return fold(text).replace(WHITESPACE, '');
}

/** Renders a doctor message with every secret withheld or masked. */
export type DoctorRedactor = (message: DoctorText | string) => string;

/**
 * The known-secret pass for one doctor run, over WHOLE messages. A plain
 * string counts as a message of one runtime part. All rules are exact matches
 * or presence checks; nothing is decoded.
 *
 * 1. If any runtime part holds a `%`, every runtime part of the message is
 *    withheld, before any masking. Every percent-encoding of a secret, at any
 *    depth and however partial, carries one, and no mask can consume it
 *    first. The cost, intended: an ordinary error with an unrelated escape (a
 *    URL with `%20`) loses its detail too.
 * 2. In each runtime part, every printed form of every secret
 *    ({@link secretForms}) is located as positions and masked. Positions, not
 *    marker characters: a literal `[redacted]` in runtime text is ordinary
 *    text.
 * 3. The whole message as a reader sees it (code-owned text and every runtime
 *    part's unmasked text, joined in order, markers deleted, all whitespace
 *    stripped) must not contain any form (whitespace-stripped too) nor any raw
 *    secret after folding: {@link compact} of the message must not contain
 *    {@link compact} of a secret, and, so that a fold adding or removing
 *    whitespace cannot hide a match either way, the plain {@link fold} of the
 *    message must not contain the plain fold of a secret. Otherwise every
 *    runtime part of the message is withheld and only the code-owned text
 *    prints. Checking the
 *    whole message means neither two adjacent runtime parts nor a runtime part
 *    and the copy beside it can rebuild a secret between them. It also catches
 *    base64 or a secret split by spaces, tabs or line breaks, and every case
 *    variant: raw matching is Unicode case-insensitive after NFKC
 *    normalisation and full case folding, per code point. A match that lies
 *    wholly in the code-owned text withholds the runtime parts too; that
 *    over-redaction is the safe failure.
 *
 * Encodings these producers do not emit (hex dumps, HTML entities, `\u`
 * escapes) are out of scope. Secrets are every secret-keyed `.env` value and
 * every credential part of a configured URL, with no length exemption.
 */
export function createDoctorRedactor(env: EnvMap): DoctorRedactor {
	const textual = new Set<string>();
	const base64 = new Set<string>();
	const compacted = new Set<string>();
	const folded = new Set<string>();
	for (const [key, value] of Object.entries(env)) {
		const raw = SECRET_KEY.test(key) ? [value, ...urlSecrets(value)] : urlSecrets(value);
		for (const secret of raw) {
			if (!secret) continue;
			const compactSecret = compact(secret);
			if (compactSecret) compacted.add(compactSecret);
			const foldedSecret = fold(secret);
			if (foldedSecret) folded.add(foldedSecret);
			const forms = secretForms(secret);
			for (const form of forms.textual) if (form) textual.add(form);
			for (const form of forms.base64) if (form) base64.add(form);
		}
	}
	const masks = [
		...[...textual].map((form) => formPattern(form, 'giu')),
		...[...base64].map((form) => formPattern(form, 'gu')),
	];
	const stripped = (forms: Set<string>) =>
		[...forms].map((form) => form.replace(WHITESPACE, '')).filter(Boolean);
	const presence = [
		...stripped(textual).map((form) => formPattern(form, 'iu')),
		...stripped(base64).map((form) => formPattern(form, 'u')),
	];
	return (message) => {
		const parts = typeof message === 'string' ? [{ text: message, trusted: false }] : message.parts;
		if (parts.some((part) => !part.trusted && part.text.includes('%'))) return withheld(parts);
		let visible = '';
		let out = '';
		for (const part of parts) {
			if (part.trusted) {
				visible += part.text;
				out += part.text;
				continue;
			}
			let from = 0;
			for (const [start, end] of mergeSpans(exactSpans(part.text, masks))) {
				visible += part.text.slice(from, start);
				out += part.text.slice(from, start) + REDACTED;
				from = end;
			}
			visible += part.text.slice(from);
			out += part.text.slice(from);
		}
		const joined = visible.replace(WHITESPACE, '');
		if (presence.some((pattern) => pattern.test(joined))) return withheld(parts);
		const compactMessage = compact(visible);
		for (const secret of compacted) if (compactMessage.includes(secret)) return withheld(parts);
		const foldedMessage = fold(visible);
		for (const secret of folded) if (foldedMessage.includes(secret)) return withheld(parts);
		return out;
	};
}

/**
 * The message with only its code-owned text: each run of runtime parts
 * becomes one `[redacted]` (an empty runtime part reveals nothing and stays
 * empty).
 */
function withheld(parts: readonly DoctorTextPart[]): string {
	let out = '';
	let pending = false;
	for (const part of parts) {
		if (!part.trusted) {
			pending ||= part.text !== '';
			continue;
		}
		if (pending) out += REDACTED;
		pending = false;
		out += part.text;
	}
	return pending ? out + REDACTED : out;
}
