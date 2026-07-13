/**
 * Trust-on-first-use (TOFU) pinning — the pure decision core of recipient-key
 * discovery (Sealed Mail, plan 2026-07-11, locked decision D1 PGP/MIME).
 *
 * When we discover a recipient's OpenPGP key (via their instance manifest + WKD,
 * see `e2ee/discovery.ts`) we PIN its fingerprint the first time we see it. On
 * every later discovery we compare what we observe against the pin:
 *
 *   - first contact                      -> `firstUse`      (pin it, trusted)
 *   - same fingerprint as the pin        -> `unchanged`     (trusted)
 *   - a DIFFERENT fingerprint, but the OLD pinned key validly signed a rotation
 *     statement binding old -> new (delivered via the manifest rotation feed)
 *                                        -> `signedRotation` (silent upgrade, trusted)
 *   - a DIFFERENT fingerprint, UNSIGNED  -> `keyChanged`     (NEVER silently
 *     re-pin; keep the old pin, surface the conflict for a human to resolve)
 *   - an operator explicitly re-accepts a `keyChanged` conflict
 *                                        -> `reaccept`       (adopt the new key)
 *
 * This module is PURE: no Convex imports, no `openpgp`, no I/O. The OpenPGP
 * signature check that produces `rotationSignatureValid` happens in the Node
 * action plane (`e2ee/discovery.ts`); here we only decide the transition. That
 * keeps the full state machine unit-testable without keys or a network
 * (`__tests__/pinning.test.ts`).
 */

import { normalizeEmail } from '@owlat/shared';

/**
 * A key-rotation statement: the OLD key attests, under its own signature, that
 * it rotated to a NEW key for `address`. Published in the manifest rotation feed
 * (`e2ee/lifecycle.ts` writes it, `e2ee/manifest.ts` serves it) and verified by
 * a peer against the fingerprint it already pinned.
 */
export interface RotationStatement {
	address: string;
	oldFingerprint: string;
	newFingerprint: string;
	/** Armored OpenPGP detached signature by the OLD key over {@link rotationStatementText}. */
	signature: string;
}

/**
 * The canonical bytes a rotation statement's signature covers — the SINGLE
 * source of truth shared by the signer (`e2ee/lifecycleNode.ts`) and the
 * verifier (`e2ee/discovery.ts`), so the two can never drift into two
 * subtly-different literals. Pure: address is normalized, fingerprints are
 * whitespace-stripped + upper-cased.
 */
export function rotationStatementText(statement: {
	address: string;
	oldFingerprint: string;
	newFingerprint: string;
}): string {
	return [
		'owlat-key-rotation',
		normalizeEmail(statement.address),
		statement.oldFingerprint.replace(/\s+/g, '').toUpperCase(),
		statement.newFingerprint.replace(/\s+/g, '').toUpperCase(),
	].join('\n');
}

/** Persisted trust state for a discovered recipient key. */
export type PinState = 'pinned' | 'keyChanged';

/** Which transition a pin evaluation took (for logging / UI copy / tests). */
export type PinAction = 'firstUse' | 'unchanged' | 'signedRotation' | 'keyChanged' | 'reaccept';

/** Inputs to a pin evaluation. */
export interface PinContext {
	/** The currently trusted (pinned) fingerprint, or `null` on first contact. */
	pinnedFingerprint: string | null;
	/** The fingerprint just observed via discovery. */
	observedFingerprint: string;
	/**
	 * Whether a rotation statement signed by the OLD pinned key validly binds the
	 * pinned fingerprint to the observed one. Only consulted when the observed key
	 * differs from the pin. Computed in the Node plane; irrelevant on first use.
	 */
	rotationSignatureValid: boolean;
}

/** The result of a pin evaluation — what to persist and whether it is usable. */
export interface PinDecision {
	action: PinAction;
	/** The fingerprint to persist as trusted after this evaluation. */
	pinnedFingerprint: string;
	/** The fingerprint observed this round (echoes the input, normalized). */
	observedFingerprint: string;
	/** Resulting trust state. */
	state: PinState;
	/**
	 * True iff the observed key equals the (new) pinned key and may therefore be
	 * used to seal mail WITHOUT prompting a human. A `keyChanged` conflict is
	 * never trusted until an explicit re-accept.
	 */
	trusted: boolean;
}

/**
 * Normalize an OpenPGP fingerprint for comparison: strip whitespace and upcase.
 * Fingerprints are hex; case and spacing are cosmetic, so `AA BB` and `aabb`
 * are the same key.
 */
export function normalizeFingerprint(fingerprint: string): string {
	return fingerprint.replace(/\s+/g, '').toUpperCase();
}

/** Case/spacing-insensitive fingerprint equality. */
export function fingerprintsEqual(a: string, b: string): boolean {
	return normalizeFingerprint(a) === normalizeFingerprint(b);
}

function decide(
	action: PinAction,
	pinnedFingerprint: string,
	observedFingerprint: string,
	state: PinState,
	trusted: boolean
): PinDecision {
	return {
		action,
		pinnedFingerprint: normalizeFingerprint(pinnedFingerprint),
		observedFingerprint: normalizeFingerprint(observedFingerprint),
		state,
		trusted,
	};
}

/**
 * The TOFU state machine. Given the current pin and a freshly-observed key,
 * decide the transition. Never throws.
 */
export function evaluatePin(ctx: PinContext): PinDecision {
	const observed = ctx.observedFingerprint;

	// First contact: trust-on-first-use — pin whatever we just saw.
	if (ctx.pinnedFingerprint === null || ctx.pinnedFingerprint === '') {
		return decide('firstUse', observed, observed, 'pinned', true);
	}

	// Same key as the pin: nothing changed, still trusted.
	if (fingerprintsEqual(ctx.pinnedFingerprint, observed)) {
		return decide('unchanged', ctx.pinnedFingerprint, observed, 'pinned', true);
	}

	// A different key, but the OLD pinned key validly signed a rotation to it:
	// silent upgrade — adopt the new key as the pin.
	if (ctx.rotationSignatureValid) {
		return decide('signedRotation', observed, observed, 'pinned', true);
	}

	// A different key with NO valid rotation: never silently re-pin. Keep the old
	// pin and surface the conflict; the observed key rides along in the row so an
	// explicit re-accept can adopt it.
	return decide('keyChanged', ctx.pinnedFingerprint, observed, 'keyChanged', false);
}

/**
 * An operator/user explicitly re-accepts a `keyChanged` conflict: adopt the
 * observed fingerprint as the new pin and return to a trusted state. This is the
 * ONLY path that re-pins across an unsigned key change.
 */
export function reacceptObservedKey(observedFingerprint: string): PinDecision {
	return decide('reaccept', observedFingerprint, observedFingerprint, 'pinned', true);
}
