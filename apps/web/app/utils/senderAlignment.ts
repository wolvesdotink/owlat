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
 */
export interface SenderAuthDisplay {
	tone: HealthTone;
	/** Short chip label. */
	label: string;
	/** One plain-language line, or `null` when the identity is clean. */
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
			label: 'Domain not verified',
			detail:
				'This domain isn’t verified, so sending from it is turned off until you verify it in Settings → Domains.',
			blocked: true,
		};
	}
	if (facts.alignment === 'misaligned') {
		return {
			tone: 'error',
			label: 'Sender not aligned',
			detail:
				facts.reason ??
				'The way this transport signs and bounces mail doesn’t match this sending address, so mailboxes can treat it as spam.',
			blocked: true,
		};
	}
	if (facts.alignment === 'unknown') {
		return {
			tone: 'warning',
			label: 'Alignment unconfirmed',
			detail:
				facts.reason ??
				'We can’t confirm this transport signs mail as this address. You can still send, but check your relay’s DKIM setup.',
			blocked: false,
		};
	}
	return {
		tone: 'success',
		label: 'Sender verified',
		detail: null,
		blocked: false,
	};
}
