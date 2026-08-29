/**
 * Contact-key verification, the reader's half (plan idea 54).
 *
 * TOFU already decided which key Owlat seals to. This module is about the step
 * TOFU cannot take for you: a person comparing that key with its owner over some
 * other channel — in the room, on a call, or by pointing a phone at a QR code —
 * and saying so.
 *
 * Two things live here, both pure so they test without mounting anything:
 *
 *   - the READ-ALOUD form. A hex fingerprint is unreadable out loud: "A-one-B-
 *     two-C-three" is where verification goes to die, and it is worse over a bad
 *     phone line in a second language. Each byte becomes a three-digit decimal
 *     number, so two people read twenty short numbers to each other instead of
 *     forty letters-that-might-be-digits. The mapping is a plain re-encoding of
 *     the same bytes, NOT a hash: what is compared is exactly the fingerprint,
 *     and anyone can check the arithmetic.
 *   - the VERIFICATION STATE derivation, mirroring the backend's
 *     `e2ee/pinning.ts:resolveVerificationState` so the badge and the server
 *     never disagree. Module scope, so it hands back catalog KEYS and the caller
 *     resolves them with `t()` at render time.
 */

/** How a contact's key reads today, given a pin and whatever was verified. */
export type ContactVerificationState = 'unverified' | 'verified' | 'stale';

/** The badge one contact renders, as catalog keys the component localizes. */
export interface ContactVerificationBadge {
	state: ContactVerificationState;
	/** Catalog key for the one-line claim. */
	summary: string;
	/** Shared seal tone (`ok` / `warn` / `muted`). */
	tone: 'ok' | 'warn' | 'muted';
	icon: string;
}

function normalize(fingerprint: string | null | undefined): string {
	return (fingerprint ?? '').replace(/\s+/g, '').toUpperCase();
}

/**
 * The state of a contact's human verification. Mirrors the backend derivation
 * exactly: a verification is only current while the fingerprint it was made
 * about is still the one we would seal to.
 */
export function resolveContactVerification(status: {
	pinnedFingerprint?: string | null;
	verifiedFingerprint?: string | null;
}): ContactVerificationState {
	const verified = normalize(status.verifiedFingerprint);
	if (!verified) return 'unverified';
	const pinned = normalize(status.pinnedFingerprint);
	if (!pinned) return 'stale';
	return pinned === verified ? 'verified' : 'stale';
}

/**
 * The badge for a contact's key. `stale` is deliberately its own state rather
 * than a silent fall back to `unverified`: "the key you checked is not the key
 * we would use" is the sentence that should make someone stop, and collapsing it
 * into "not verified yet" throws away the only interesting half.
 */
export function deriveContactVerificationBadge(
	status: {
		pinnedFingerprint?: string | null;
		verifiedFingerprint?: string | null;
	},
	verifiedByMe = false
): ContactVerificationBadge {
	const state = resolveContactVerification(status);
	if (state === 'verified') {
		return {
			state,
			summary: verifiedByMe
				? 'shared.postboxKeyVerification.verifiedByYou'
				: 'shared.postboxKeyVerification.verifiedByTeammate',
			tone: 'ok',
			icon: 'lucide:badge-check',
		};
	}
	if (state === 'stale') {
		return {
			state,
			summary: 'shared.postboxKeyVerification.stale',
			tone: 'warn',
			icon: 'lucide:badge-alert',
		};
	}
	return {
		state,
		summary: 'shared.postboxKeyVerification.unverified',
		tone: 'muted',
		icon: 'lucide:badge-help',
	};
}

/**
 * The read-aloud form: one zero-padded three-digit decimal number per byte of
 * the fingerprint. `A1B2` becomes `161 178`.
 *
 * Returns an empty array for an absent or malformed fingerprint (anything but an
 * even-length run of hex), so a caller can `v-if` on `.length` rather than
 * rendering half a number pair that would be read aloud as truth.
 */
export function readAloudFingerprint(fingerprint: string | null | undefined): string[] {
	const hex = normalize(fingerprint);
	if (!hex || hex.length % 2 !== 0 || !/^[0-9A-F]+$/.test(hex)) return [];
	const groups: string[] = [];
	for (let i = 0; i < hex.length; i += 2) {
		groups.push(String(Number.parseInt(hex.slice(i, i + 2), 16)).padStart(3, '0'));
	}
	return groups;
}

/**
 * The read-aloud numbers wrapped into lines of `perLine`, so the pair reading
 * them to each other can keep their place. Five to a line matches how people
 * chunk a phone number.
 */
export function readAloudLines(fingerprint: string | null | undefined, perLine = 5): string[] {
	const groups = readAloudFingerprint(fingerprint);
	const lines: string[] = [];
	for (let i = 0; i < groups.length; i += perLine) {
		lines.push(groups.slice(i, i + perLine).join(' '));
	}
	return lines;
}
