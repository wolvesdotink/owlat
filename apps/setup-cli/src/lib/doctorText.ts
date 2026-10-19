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
 * Full case folding after compatibility normalisation. NFKC unifies composed
 * and decomposed accents and compatibility forms. The case mapping is
 * lower, then upper, then lower: upper-then-lower alone would keep the
 * capital `ẞ` (already upper case) as `ß`, while lowering it first lets `ß`,
 * `ẞ` and `SS` all end as `ss`. NFKC runs again at the end, because case
 * mapping can produce decomposed sequences (`ǰ` upper-cases to `J` + U+030C).
 */
function fold(text: string): string {
	return text.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase().normalize('NFKC');
}

/**
 * The known-secret pass for one doctor run, over untrusted text only. Three
 * rules, all exact matches or presence checks; nothing is decoded.
 *
 * 1. A part holding a `%` anywhere is withheld whole, before any masking.
 *    Every percent-encoding of a secret, at any depth and however partial,
 *    carries one, and no mask can consume it first. The cost, intended: an
 *    ordinary error with an unrelated escape (a URL with `%20`) loses its
 *    detail too.
 * 2. Every printed form of every secret ({@link secretForms}) is located as
 *    positions in the input and the union is masked. Positions, not marker
 *    characters: a literal `[redacted]` in runtime text is ordinary text.
 * 3. The text left outside the masks, joined as a reader would join it after
 *    deleting the markers and stripped of all whitespace, must not contain any
 *    form (whitespace-stripped too), nor, after {@link fold}, any folded raw
 *    secret; otherwise the whole part is withheld. That catches base64 or a
 *    secret split by spaces, tabs or line breaks, and every case variant:
 *    raw matching is Unicode case-insensitive after NFKC normalisation and full
 *    case folding (lower, upper, then lower), so `STRASSE-PAß-42` cannot slip
 *    past a secret `Straße-paß-42`. Joining can occasionally create a match that was
 *    not there; withholding then is the safe failure.
 *
 * Encodings these producers do not emit (hex dumps, HTML entities, `\u`
 * escapes) are out of scope. Secrets are every secret-keyed `.env` value and
 * every credential part of a configured URL, with no length exemption:
 * code-owned text is out of reach, so over-redaction only costs runtime detail.
 */
export function createDoctorRedactor(env: EnvMap): (text: string) => string {
	const textual = new Set<string>();
	const base64 = new Set<string>();
	const folded = new Set<string>();
	for (const [key, value] of Object.entries(env)) {
		const raw = SECRET_KEY.test(key) ? [value, ...urlSecrets(value)] : urlSecrets(value);
		for (const secret of raw) {
			if (!secret) continue;
			const foldedSecret = fold(secret.replace(WHITESPACE, ''));
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
	const compact = (forms: Set<string>) =>
		[...forms].map((form) => form.replace(WHITESPACE, '')).filter(Boolean);
	const presence = [
		...compact(textual).map((form) => formPattern(form, 'iu')),
		...compact(base64).map((form) => formPattern(form, 'u')),
	];
	return (text) => {
		if (text.includes('%')) return REDACTED;
		let visible = '';
		let out = '';
		let from = 0;
		for (const [start, end] of mergeSpans(exactSpans(text, masks))) {
			visible += text.slice(from, start);
			out += text.slice(from, start) + REDACTED;
			from = end;
		}
		visible += text.slice(from);
		const joined = visible.replace(WHITESPACE, '');
		if (presence.some((pattern) => pattern.test(joined))) return REDACTED;
		const foldedJoined = fold(joined);
		for (const secret of folded) if (foldedJoined.includes(secret)) return REDACTED;
		return out + text.slice(from);
	};
}
