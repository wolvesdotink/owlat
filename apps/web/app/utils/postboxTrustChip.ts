/**
 * ONE trust verdict per message, for the reader's single trust chip (plan §05).
 *
 * The reader used to spend up to five separate indicators on the sender line —
 * the verified-sender badge, the PGP/S-MIME security badge, the sealed-mail
 * badge, the tracking-pixel shield and the correspondent's sealing-key panel —
 * each with its own tone and its own pixel budget. They all answer the same
 * question ("can I trust what I am looking at?"), so they collapse into one chip
 * whose popover still shows every one of them in full.
 *
 * This module is the chip's *label and tone*, and nothing else. It is pure and
 * module-scope, so it hands back catalog KEYS (or `{ key, params }` pairs, the
 * `SenderAuthText` convention) and never calls `useI18n`; the chip resolves them
 * at render time.
 *
 * The honesty rule the badges already live by carries over unchanged: a chip may
 * never claim more than what was actually checked. With no verdicts at all —
 * both flags off, a legacy row, an older MTA — the chip reads "not checked"
 * rather than green, and green is reachable only through a driver that itself
 * reached an "ok" state.
 *
 * Priority of the driver that gets to NAME the state, highest first:
 *   1. the inbound sealing record (Sealed Mail E5, flag `sealedMail`)
 *   2. the inbound PGP signature verdict (F2)
 *   3. structural encryption we never decrypted (no record to go on)
 *   4. the sender-authentication verdicts (Sealed Mail A3, flag `senderAuthBadges`)
 *
 * On top of that, three things ESCALATE an otherwise-fine chip to amber without
 * renaming it, because each is "worth a look" rather than a verdict: an
 * impersonation heuristic fired, tracking pixels were found, or the
 * correspondent's pinned sealing key changed unsigned.
 */
import { isEncryptedClass, type SecureMessageClass } from '@owlat/shared/secureMessage';
import { deriveSealedBadge, type InboundEncryptionInfo } from './sealedMessage';
import { deriveSignatureBadge, type InboundSignatureInfo } from './signatureBadge';
import {
	deriveSenderAuth,
	deriveSenderHeuristicLines,
	type SenderAuthInput,
	type SenderAuthText,
	type SenderHeuristics,
} from './senderAuth';

export interface TrustChipInput {
	/** Feature flag `senderAuthBadges`. */
	authEnabled: boolean;
	auth: SenderAuthInput;
	heuristics?: SenderHeuristics;
	/** Feature flag `sealedMail`. */
	sealedEnabled: boolean;
	sealed?: InboundEncryptionInfo;
	signature?: InboundSignatureInfo;
	/** Structural PGP/S-MIME detection (no cryptographic claim of its own). */
	secureClass: SecureMessageClass;
	/** Tracking pixels the rendered body reported (0 = none found). */
	trackerPixels: number;
	/** The correspondent's pinned sealing key rotated without a signed change. */
	keyChanged: boolean;
}

/** Quiet green when everything checked out, amber when something wants a look. */
export type TrustChipTone = 'ok' | 'attention' | 'unknown';

export interface TrustChipResult {
	tone: TrustChipTone;
	icon: string;
	/** Short chip label — a catalog key, or a `{ key, params }` pair. */
	summary: SenderAuthText;
}

const TONE_ICON: Record<TrustChipTone, string> = {
	ok: 'lucide:shield-check',
	attention: 'lucide:shield-alert',
	unknown: 'lucide:shield',
};

/** The one driver that gets to name the state, or null when none can. */
function primaryDriver(
	input: TrustChipInput
): { summary: string; icon: string; ok: boolean } | null {
	const sealed = input.sealedEnabled ? deriveSealedBadge(input.sealed) : null;
	if (sealed) return { summary: sealed.summary, icon: sealed.icon, ok: sealed.tone === 'ok' };

	const signature = deriveSignatureBadge(input.signature, input.sealed);
	if (signature && signature.tone !== 'muted') {
		return { summary: signature.summary, icon: signature.icon, ok: signature.tone === 'ok' };
	}

	// Ciphertext with no sealing record behind it: we can say it is encrypted and
	// that we did not open it, and nothing more.
	if (isEncryptedClass(input.secureClass)) {
		return {
			summary: 'components.postbox.postboxSecurityBadge.encrypted',
			icon: 'lucide:lock',
			ok: false,
		};
	}

	const auth = input.authEnabled ? deriveSenderAuth(input.auth) : null;
	if (auth) return { summary: auth.summary, icon: auth.icon, ok: auth.tone === 'ok' };

	return null;
}

/**
 * Derive the chip. Never throws and never asserts: every reachable state maps
 * 1:1 to a condition, which is what the unit test enumerates.
 */
export function deriveTrustChip(input: TrustChipInput): TrustChipResult {
	const primary = primaryDriver(input);
	const escalated =
		input.keyChanged ||
		input.trackerPixels > 0 ||
		(input.authEnabled && deriveSenderHeuristicLines(input.heuristics).length > 0);

	// A driver that already says something is wrong keeps its own words: naming
	// the failure beats a generic "worth a look".
	if (primary && !primary.ok) {
		return { tone: 'attention', icon: primary.icon, summary: primary.summary };
	}
	// Something fired that no driver names — say so rather than paint the chip
	// green over it.
	if (escalated) {
		return {
			tone: 'attention',
			icon: TONE_ICON.attention,
			summary: 'components.postbox.postboxTrustChip.worthALook',
		};
	}
	if (primary) return { tone: 'ok', icon: primary.icon, summary: primary.summary };
	return {
		tone: 'unknown',
		icon: TONE_ICON.unknown,
		summary: 'components.postbox.postboxTrustChip.notChecked',
	};
}

/** Chip styling per tone. FF tokens only, matching the badges it replaces. */
export const TRUST_CHIP_TONE_CLASSES: Record<TrustChipTone, { chip: string; icon: string }> = {
	ok: { chip: 'border-border-subtle text-text-secondary', icon: 'text-success' },
	attention: { chip: 'border-warning/40 text-warning', icon: 'text-warning' },
	unknown: { chip: 'border-border-subtle text-text-tertiary', icon: 'text-text-tertiary' },
};
