/**
 * Reader signature-badge derivation for inbound PGP-SIGNED (unencrypted) mail
 * (F2, adoption-gaps plan 2026-08-16, decision D9). Turns the honest signature
 * verdict persisted at ingest (F1, `mailMessages.inboundSignatureInfo`) into
 * ONE badge state, and owns the badge PRECEDENCE rule:
 *
 *   sealed record → signature record → structural class ("not verified")
 *
 * A present sealed record always wins (this driver yields `null` and the
 * sealed driver renders); a usable signature verdict replaces the structural
 * chip's hardcoded "· not verified" suffix; no record (or an unusable one)
 * falls back to the structural class, whose copy stays "not verified".
 *
 * The cardinal rule (the honesty audit is a test, not a vibe — same as
 * `sealedMessage.ts` and `senderAuth.ts`): a state may never claim more than
 * what was cryptographically checked. "Signed · verified" is reachable ONLY
 * when the signature verified against the pinned/discovered sender key —
 * `isSignatureValid === true` AND a `signerFingerprint` present. A verdict the
 * verifier could not actually produce (`failure: 'verification_error'`, or an
 * inconsistent record) renders NO claim at all: the structural "not verified"
 * fallback shows instead.
 *
 * This is the web-side mirror of the Convex `InboundSignatureInfo` record
 * (single source is `e2ee/inboundSignature.ts`); the boundary keeps its own
 * copy per this app's existing cross-package pattern (see `utils/senderAuth.ts`).
 *
 * The derivation is module scope, so it never calls `useI18n`: `summary`,
 * `tooltip` and `keySource` are catalog KEYS (the `sealedMessage.ts`
 * convention), and the reader resolves them with `t()` at render time.
 */

import { formatFingerprint, shortFingerprint } from '~/utils/fingerprints';
import type { InboundEncryptionInfo } from '~/utils/sealedMessage';

/** Web mirror of the Convex `InboundSignatureKeySource` union (`e2ee/inboundSignature.ts`). */
export type InboundSignatureKeySource = 'pinned' | 'wkd' | 'manifest' | 'not_found';

/** Web mirror of the Convex `InboundSignatureInfo` record (`e2ee/inboundSignature.ts`). */
export type InboundSignatureInfo = {
	isSigned: true;
	isSignatureValid: boolean;
	/** Uppercase-hex fingerprint of the signing key — present only when verified. */
	signerFingerprint?: string;
	keySource: InboundSignatureKeySource;
	failure?: string;
};

export type SignatureBadgeState = 'verified' | 'invalid' | 'keyNotFound' | 'keyChanged';

export interface SignatureBadgeResult {
	state: SignatureBadgeState;
	/** Short chip label — a catalog key, resolved with `t()` at render time. */
	summary: string;
	/**
	 * Hover tooltip — a catalog key. The two states that name where the key came
	 * from interpolate `{source}` (from {@link SignatureBadgeResult.keySource})
	 * and `{fingerprint}`; the reader fills both in.
	 */
	tooltip: string;
	tone: 'ok' | 'warn' | 'danger' | 'muted';
	icon: string;
	/** Catalog key naming the key's origin — present when the tooltip needs it. */
	keySource?: string;
	/** Full formatted fingerprint (grouped by 4) — present only when verified. */
	fingerprint?: string;
	/** Short fingerprint tail for the inline chip — present only when verified. */
	fingerprintShort?: string;
}

/** Plain-language origin of the verification key, for the tooltip — catalog keys. */
const KEY_SOURCE_LABELS: Record<Exclude<InboundSignatureKeySource, 'not_found'>, string> = {
	pinned: 'shared.signatureBadge.keySources.pinned',
	wkd: 'shared.signatureBadge.keySources.wkd',
	manifest: 'shared.signatureBadge.keySources.manifest',
};

/**
 * Derive the reader's signature badge from the inbound verdict, honoring the
 * D9 precedence: a present SEALED record always wins, so this returns `null`
 * whenever `sealed` is given (the sealed driver renders instead). Pure — no
 * side effects — so the honesty audit can enumerate every reachable string
 * against its condition.
 *
 * Returns `null` (→ the structural "not verified" fallback) when:
 *   - there is no signature record at all (plaintext / legacy / pre-F1 row);
 *   - the verifier itself failed (`failure: 'verification_error'`) — we hold
 *     no verdict, so we assert neither "verified" nor "invalid";
 *   - the record is inconsistent (valid without a fingerprint) — the pin match
 *     is missing, so no claim is representable.
 */
export function deriveSignatureBadge(
	info: InboundSignatureInfo | undefined,
	sealed?: InboundEncryptionInfo
): SignatureBadgeResult | null {
	// Precedence: the sealed record's driver owns the badge outright.
	if (sealed) return null;
	if (!info?.isSigned) return null;

	// The ONLY path to "verified": the signature verified against the pinned/
	// discovered sender key AND the verdict carries the signer's fingerprint.
	// `isSignatureValid` alone is not enough — same double gate as the sealed
	// driver. An inconsistent record (valid, no fingerprint) claims nothing.
	if (info.isSignatureValid) {
		if (!info.signerFingerprint || info.keySource === 'not_found') return null;
		const full = formatFingerprint(info.signerFingerprint) ?? '';
		return {
			state: 'verified',
			summary: 'shared.signatureBadge.verified.summary',
			tooltip: 'shared.signatureBadge.verified.tooltip',
			tone: 'ok',
			icon: 'lucide:pen-tool',
			keySource: KEY_SOURCE_LABELS[info.keySource],
			fingerprint: full,
			fingerprintShort: shortFingerprint(info.signerFingerprint) ?? undefined,
		};
	}

	// Fail-closed pin refusal (identical to sealed mail): the sender's observed
	// key conflicts with the TOFU pin, so verification was REFUSED — the
	// loudest state, because a silent key change is the impersonation shape.
	if (info.failure === 'key_changed') {
		return {
			state: 'keyChanged',
			summary: 'shared.signatureBadge.keyChanged.summary',
			tooltip: 'shared.signatureBadge.keyChanged.tooltip',
			tone: 'danger',
			icon: 'lucide:pen-tool',
		};
	}

	// The verifier itself failed — we hold NO verdict, so neither "verified"
	// nor "invalid" is honest. Fall back to the structural "not verified".
	if (info.failure === 'verification_error') return null;

	// No key anywhere (WKD lookup + pins came up empty) ⇒ verification was
	// never possible. Neutral, not alarming: an unknown sender, not a bad one.
	if (info.keySource === 'not_found') {
		return {
			state: 'keyNotFound',
			summary: 'shared.signatureBadge.keyNotFound.summary',
			tooltip: 'shared.signatureBadge.keyNotFound.tooltip',
			tone: 'muted',
			icon: 'lucide:pen-tool',
		};
	}

	// The crypto ran against a real sender key and did NOT verify — a tampered
	// body, a wrong key, or an unparseable signature part.
	return {
		state: 'invalid',
		summary: 'shared.signatureBadge.invalid.summary',
		tooltip: 'shared.signatureBadge.invalid.tooltip',
		tone: 'warn',
		icon: 'lucide:pen-tool',
		keySource: KEY_SOURCE_LABELS[info.keySource],
	};
}
