/**
 * The BATV-style signed-token core shared by the two feedback handles Owlat
 * publishes to the internet: the VERP bounce return-path (`bounce/verp.ts`) and
 * the RFC 9477 complaint address (`bounce/cfblAddress.ts`).
 *
 * Both encode an opaque message id into an address local-part and authenticate
 * it with a truncated HMAC over a coarse time window, for the same reason:
 * anyone may mail a null-sender report at us, so attribution must come from a
 * token we actually signed rather than from bytes a stranger chose.
 *
 * The ONE thing that differs between them is the DOMAIN-SEPARATION LABEL fed
 * into the MAC. Keeping the label a parameter of one implementation — instead of
 * two near-identical copies with a prose comment each — is what makes the
 * separation property checkable: a captured bounce token cannot be replayed as a
 * complaint token (or vice versa) because the label is part of the signed input,
 * and there is exactly one place where that input is built.
 *
 * Everything here is pure apart from the optional `process.env` key lookup: the
 * clock is a parameter, nothing throws, and a verification failure is a returned
 * value the caller classifies and counts.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** Length (chars) of the base64url-encoded truncated HMAC carried in a token. */
export const MAC_B64URL_LEN = 14; // ~84 bits — comfortably above the audit's 10-char floor

/** Window granularity: one bucket per UTC day. */
export const SIGNED_TOKEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the shared signing key (`BOUNCE_VERP_KEY`). One secret safely serves
 * both token families because the MAC input is domain-separated by label.
 * Tests pass the key explicitly; an empty/undefined key means "unsigned", which
 * production startup rejects.
 *
 * Reading the env HERE, rather than threading it through every caller, is what
 * keeps `buildVerpAddress` / `parseVerpAddress` / `buildCfblAddress` drop-in for
 * their existing call sites.
 */
export function resolveSignedTokenKey(explicit?: string): string | undefined {
	const key = explicit ?? process.env['BOUNCE_VERP_KEY'];
	return key && key.length > 0 ? key : undefined;
}

/**
 * One future window absorbs signer/verifier clock skew around a day boundary.
 * Shared by both token families so the skew allowance cannot drift apart.
 */
export const SIGNED_TOKEN_FUTURE_WINDOWS = 1;

/**
 * The LONGEST span over which any feedback token Owlat publishes to the
 * internet still verifies — today, the accepted past windows and the future
 * skew window. Complaints are a human-latency signal (a subscriber may report a
 * two-week-old newsletter), so this is deliberately wide: 14 days of acceptance
 * plus one day of skew.
 *
 * THIS IS THE ONE VALUE THREE RETENTIONS DERIVE FROM, and it lives here rather
 * than in either token module because it constrains both of them plus the two
 * stores that must outlive them:
 *   1. `cfblAddress.ts` turns it into its accepted-window count;
 *   2. `complaintDedupStore.ts` keeps a completed complaint at least this long —
 *      a replay landing after the dedup record expired but while the token still
 *      verifies would be counted a second time, inflating a complaint rate by
 *      pure repetition;
 *   3. `feedbackProvenance.ts` keeps the send record at least this long — it is
 *      the only source of organizationId/campaignId/deliveryDomain, so a report
 *      that verifies but outlives its record attributes to nothing and cannot
 *      feed the complaint gate.
 *
 * Widening the horizon therefore widens all three together, by construction.
 */
export const MAX_FEEDBACK_TOKEN_ACCEPTANCE_SECONDS = 15 * 24 * 60 * 60;

/**
 * Retention for state that must OUTLIVE a verifiable token: the acceptance
 * horizon plus one day of slack for clock skew between the signer, the
 * reporting provider and the store.
 */
export const FEEDBACK_RECORD_RETENTION_SECONDS =
	MAX_FEEDBACK_TOKEN_ACCEPTANCE_SECONDS + 24 * 60 * 60;

/** Current coarse time bucket (UTC day number). Injectable for tests. */
export function currentSignedTokenWindow(now: number): number {
	return Math.floor(now / SIGNED_TOKEN_WINDOW_MS);
}

/**
 * Truncated base64url MAC over `{label}{encodedId}:{window}`.
 *
 * `label` is the domain separator (`''` for VERP, `'cfbl:'` for the complaint
 * address). Signing the ALREADY base64url-encoded id keeps the MAC input free of
 * `@`/`+`/`=` so every token grammar built on it stays unambiguous.
 */
export function computeSignedTokenMac(
	label: string,
	encodedId: string,
	window: number,
	key: string
): string {
	return createHmac('sha256', key)
		.update(`${label}${encodedId}:${window}`)
		.digest('base64url')
		.slice(0, MAC_B64URL_LEN);
}

/** Constant-time compare that never throws on a length mismatch. */
export function signedTokenMacsEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/**
 * Find the time window a presented MAC was signed in, or `null` if none in
 * range matches.
 *
 * Returns the age in whole windows: `0` is the current window, negative values
 * are future windows (clock skew), positive values are past ones. The caller
 * decides which ages it ACCEPTS — probing further back than the acceptance
 * horizon is how `cfblAddress.ts` tells "expired" apart from "forged" — so the
 * probe depth is a parameter, bounded by the caller to keep a junk-report flood
 * from becoming a CPU amplifier.
 *
 * Cost is exactly `pastWindows + futureWindows + 1` HMACs worst case.
 */
export function findSignedTokenWindowAge(params: {
	readonly label: string;
	readonly encodedId: string;
	readonly presentedMac: string;
	readonly key: string;
	readonly now: number;
	readonly pastWindows: number;
	readonly futureWindows: number;
}): number | null {
	const base = currentSignedTokenWindow(params.now);
	for (let age = -params.futureWindows; age <= params.pastWindows; age++) {
		const expected = computeSignedTokenMac(params.label, params.encodedId, base - age, params.key);
		if (signedTokenMacsEqual(expected, params.presentedMac)) return age;
	}
	return null;
}
