import type { OutboundAlignmentState } from '@owlat/shared';
import type { HealthTone } from '~/utils/healthTone';

/**
 * Map a From-identity's verification + outbound-alignment facts to the honest
 * chip the From-pickers render. This is the single source of truth for BOTH the
 * chip copy and the "should the picker block a send from this identity?" gate, so
 * the two can't drift.
 *
 * Honesty (asserted verbatim in the chip's component test): each state claims
 * only what was actually checked. `blocked` is true only for a DEFINITE problem —
 * an unverified domain (sending is genuinely off) or a `misaligned` transport
 * (DMARC will fail). An `unknown` alignment (a relay whose identities aren't
 * declared) is surfaced as a soft caution but never blocks — we didn't verify a
 * failure, so we don't assert one.
 *
 * Module scope, so it never calls `useI18n`: `label` and this module's own
 * `detail` copy are catalog KEYS the chip resolves with `t()` at render time.
 * The one exception is a transport's `reason`, which arrives already worded from
 * the alignment check and is passed through verbatim.
 */
export interface SenderAuthDisplay {
	tone: HealthTone;
	/** Short chip label — a catalog key. */
	label: string;
	/**
	 * One plain-language line, or `null` when the identity is clean. A catalog
	 * key, unless the alignment check supplied its own worded reason.
	 */
	detail: string | null;
	/** Whether the picker should disable sending from this identity. */
	blocked: boolean;
}

export interface SenderAuthFacts {
	/** The sender's domain still passes verification. */
	verified: boolean;
	/** Whether the active transport signs/bounces this From-domain in a DMARC-aligned way. */
	alignment: OutboundAlignmentState;
	/** Plain-language guidance from the alignment check, when not cleanly aligned. */
	reason?: string | null;
}

/**
 * The subset of a send-as identity this module reasons about. Structural on
 * purpose: the composer's `SendAsIdentity` (a Convex return type) satisfies it
 * without this pure module depending on the backend's shape.
 */
export interface AlignableIdentity {
	address: string;
	domainVerified: boolean;
	alignment: OutboundAlignmentState;
	alignmentReason?: string | null;
}

/**
 * The identity a composer is currently sending as: the chosen From, falling
 * back to the first available (which is what the picker itself displays when
 * `fromAddress` has not been set yet). Null when there are no identities.
 */
export function selectedSenderIdentity<T extends AlignableIdentity>(
	identities: readonly T[],
	fromAddress: string
): T | null {
	const address = fromAddress || identities[0]?.address || '';
	return identities.find((identity) => identity.address === address) ?? null;
}

/**
 * The pre-send half of the same verdict: is this identity a DEFINITE delivery
 * failure — an unverified domain (sending is off) or a misaligned transport
 * (DMARC will fail)? Returns the display (label, reason, tone) to warn with, or
 * null when there is nothing certain to say.
 *
 * `blocked` is reused deliberately: it is already the "we verified a real
 * problem" flag, so the composer's warning and the picker's disabled option can
 * never disagree about which identities are broken. An `unknown` alignment is
 * NOT a warning here — we did not verify a failure, so we do not predict one.
 *
 * The composer WARNS on this and never hard-blocks: a self-hoster mid-setup
 * must still be able to send.
 */
export function alignmentSendWarning(facts: SenderAuthFacts | null): SenderAuthDisplay | null {
	if (!facts) return null;
	const display = senderAuthDisplay(facts);
	return display.blocked ? display : null;
}

export function senderAuthDisplay(facts: SenderAuthFacts): SenderAuthDisplay {
	if (!facts.verified) {
		return {
			tone: 'warning',
			label: 'shared.senderAlignment.notVerified.label',
			detail: 'shared.senderAlignment.notVerified.detail',
			blocked: true,
		};
	}
	if (facts.alignment === 'misaligned') {
		return {
			tone: 'error',
			label: 'shared.senderAlignment.misaligned.label',
			detail: facts.reason ?? 'shared.senderAlignment.misaligned.detail',
			blocked: true,
		};
	}
	if (facts.alignment === 'unknown') {
		return {
			tone: 'warning',
			label: 'shared.senderAlignment.unknown.label',
			detail: facts.reason ?? 'shared.senderAlignment.unknown.detail',
			blocked: false,
		};
	}
	return {
		tone: 'success',
		label: 'shared.senderAlignment.verified.label',
		detail: null,
		blocked: false,
	};
}
