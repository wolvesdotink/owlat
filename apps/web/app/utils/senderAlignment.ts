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
