/**
 * TOTP enrolment helpers (plan idea 57).
 *
 * BetterAuth hands the client one string — an `otpauth://totp/...` URI — and a
 * list of backup codes, and considers its job done. Turning that into something
 * a person can actually enrol with is three jobs, all pure, all here:
 *
 *  1. a QR the camera can read, without shipping a QR dependency's SVG string
 *     into `v-html` (we take uqr's boolean matrix and emit ONE `<path>` the
 *     template renders as data — no raw markup crosses the boundary);
 *  2. the manual fallback, because a camera is not always the thing in front of
 *     you: the same secret, grouped in fours, typeable;
 *  3. a backup-codes file that still means something in six months, when it is
 *     found in a downloads folder with no memory attached.
 *
 * No `useI18n`, no auth client, no DOM. The download is assembled as a string
 * and handed to the caller.
 */

import { encode } from 'uqr';

/** The parts of an `otpauth://` URI a person may need to see or retype. */
export type TotpEnrolment = {
	/** The Base32 shared secret, as the authenticator app wants it typed. */
	secret: string;
	/** Whoever issued it ("Owlat"), for the manual-entry form's account field. */
	issuer: string | null;
	/** The account label, normally the login email. */
	account: string | null;
};

/**
 * Read the enrolment out of a TOTP URI.
 *
 * Returns `null` for anything that is not a TOTP URI carrying a secret, so a
 * caller can never render a QR for one shape and a manual key for another.
 */
export function parseTotpUri(uri: string | null | undefined): TotpEnrolment | null {
	if (!uri) return null;
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'otpauth:' || parsed.host.toLowerCase() !== 'totp') return null;

	const secret = (parsed.searchParams.get('secret') ?? '').trim();
	if (!secret) return null;

	// The path label is `Issuer:account` (both percent-encoded); the `issuer`
	// query parameter repeats the issuer and wins when the two disagree, which
	// is what RFC-adjacent authenticator apps do.
	const label = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
	const separator = label.indexOf(':');
	const labelIssuer = separator === -1 ? null : label.slice(0, separator);
	const account = separator === -1 ? label : label.slice(separator + 1);

	return {
		secret,
		issuer: parsed.searchParams.get('issuer') || labelIssuer || null,
		account: account.trim() || null,
	};
}

/**
 * Group a Base32 secret in fours.
 *
 * Every authenticator's manual-entry field accepts spaces and strips them; a
 * 32-character unbroken run does not survive being retyped off a screen.
 */
export function groupSecret(secret: string): string {
	const compact = secret.replace(/\s+/g, '').toUpperCase();
	return (compact.match(/.{1,4}/g) ?? []).join(' ');
}

/** A QR ready to render as a single SVG `<path>`, with no markup string. */
export type TotpQrCode = {
	/** Modules per side. The viewBox is `0 0 size size`; one module is one unit. */
	size: number;
	/** The `d` attribute: one sub-path per horizontal run of dark modules. */
	path: string;
};

/**
 * Encode a TOTP URI as QR path data.
 *
 * Horizontal runs are merged into one rectangle each, which is what keeps the
 * path an order of magnitude shorter than a per-module `<rect>` soup and lets
 * the whole code live in the DOM as a single node.
 */
export function totpQrCode(uri: string): TotpQrCode {
	const { size, data } = encode(uri, { ecc: 'M', border: 1 });
	const segments: string[] = [];

	for (let y = 0; y < data.length; y++) {
		const row = data[y]!;
		let runStart = -1;
		for (let x = 0; x <= row.length; x++) {
			const dark = x < row.length && row[x] === true;
			if (dark && runStart === -1) runStart = x;
			if (!dark && runStart !== -1) {
				segments.push(`M${runStart} ${y}h${x - runStart}v1h-${x - runStart}z`);
				runStart = -1;
			}
		}
	}

	return { size, path: segments.join('') };
}

/**
 * Did sign-in stop at the second factor?
 *
 * BetterAuth answers a password sign-in for a 2FA account with HTTP 200 and
 * `{ twoFactorRedirect: true }` — NO session, no error. Read as an ordinary
 * success (which is what every caller did before the plugin was wired), that
 * response sends the user to a dashboard they are not signed in to. This is the
 * one probe that tells the two apart, so it lives next to the rest of the TOTP
 * logic instead of being re-inlined at each call site.
 */
export function requiresTwoFactor(signInData: unknown): boolean {
	return (
		typeof signInData === 'object' &&
		signInData !== null &&
		(signInData as { twoFactorRedirect?: unknown }).twoFactorRedirect === true
	);
}

/** Strip everything an authenticator never shows: only the six digits survive. */
export function normalizeTotpCode(input: string): string {
	return input.replace(/\D/g, '').slice(0, 6);
}

/** A code is submittable at exactly six digits — not five, not seven. */
export function isCompleteTotpCode(code: string): boolean {
	return /^\d{6}$/.test(code);
}

/**
 * The backup-codes file.
 *
 * Written as a document rather than a bare list: found months later with no
 * context, `owlat-backup-codes.txt` has to say which account it opens, when it
 * was issued, and that each code works once. The caller supplies every string,
 * so this stays free of `useI18n` while the file itself is still localised.
 */
export function buildBackupCodesFile(input: {
	codes: readonly string[];
	heading: string;
	accountLine: string;
	issuedLine: string;
	notes: readonly string[];
}): string {
	const lines = [
		input.heading,
		'='.repeat(input.heading.length),
		'',
		input.accountLine,
		input.issuedLine,
		'',
		...input.codes.map((code) => `  ${code}`),
		'',
		...input.notes,
		'',
	];
	return lines.join('\n');
}

/**
 * A filename that sorts and reads well next to whatever else is in Downloads.
 * The date is the calendar day in the caller's own timezone, not UTC, so it
 * matches what the issued line above says.
 */
export function backupCodesFilename(issuedAt: Date): string {
	const pad = (value: number) => String(value).padStart(2, '0');
	const stamp = `${issuedAt.getFullYear()}-${pad(issuedAt.getMonth() + 1)}-${pad(issuedAt.getDate())}`;
	return `owlat-backup-codes-${stamp}.txt`;
}
