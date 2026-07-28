/**
 * BIMI — OFFERED, never required, never a nag (P4-7).
 *
 * BIMI puts a brand logo next to the message at participating receivers, and it
 * is meaningful ONLY once DMARC is actually enforcing: the spec requires the
 * From domain to publish `p=quarantine` or `p=reject` (RFC-track BIMI draft
 * §7.1), and a `pct=` below 100 leaves part of the mail unenforced, which
 * receivers treat the same way. So the record is offered exactly when the
 * precondition holds and is silent otherwise — an operator at `p=none` sees
 * nothing about BIMI at all, not a warning and not a "setup incomplete" item.
 *
 * THE VMC. Gmail and Apple Mail both require a Verified Mark Certificate — a
 * paid certificate from a small number of issuers — before they will display
 * the logo; other receivers show it from the record alone. That is stated
 * plainly on the offer rather than discovered after the operator has published
 * a record and wondered why nothing changed.
 *
 * D2 — this is a third-party-shaped feature (a VMC is bought from an external
 * CA) and is therefore ADDITIVE-ONLY: no BIMI record, no VMC, no logo is ever a
 * blocked send, a blocked phase promotion, an error state, or an unresolvable
 * warning. The offer's `required` and `nag` fields are literal `false` so no
 * caller can render it as anything else.
 *
 * Pure — policy, pct, logo and VMC URLs are all parameters.
 */

import { zoneRelativeHost } from '@owlat/shared/dnsZone';
import type { DmarcPolicy } from './dmarc';

/** The weakest DMARC policy at which BIMI is meaningful. */
export const BIMI_MIN_DMARC_POLICY: DmarcPolicy = 'quarantine';

/** The default BIMI selector, per the spec's `default._bimi` convention. */
export const BIMI_DEFAULT_SELECTOR = 'default';

/**
 * Receivers that will not display a logo without a VMC. Named rather than
 * summarised so the wizard can list them and the test can pin them.
 */
export const BIMI_VMC_REQUIRED_RECEIVERS = ['gmail', 'apple'] as const;

export const BIMI_VMC_NOTE =
	'Gmail and Apple Mail require a Verified Mark Certificate (VMC) — a paid certificate for your trademarked logo — before they will display it. Other receivers show the logo from the record alone. Publishing BIMI without a VMC is safe; it simply does nothing at those two.';

export type BimiIneligibleReason = 'dmarc_policy_below_quarantine' | 'dmarc_pct_below_100';

/**
 * A BIMI record the operator MAY publish. Never a checklist item, never a
 * blocker, and absent entirely when the DMARC precondition is not met.
 */
export interface BimiOffer {
	/** True only when DMARC is at `p=quarantine` or stricter at full `pct`. */
	offered: boolean;
	/** Why the offer is withheld. `null` when it is offered. */
	ineligibleReason: BimiIneligibleReason | null;
	/**
	 * The record, when a logo URL is known. `null` when the offer is withheld
	 * OR when the operator has not supplied an SVG logo yet — the wizard then
	 * asks for the logo rather than emitting a record with an empty `l=`.
	 */
	record: { type: 'TXT'; host: string; relativeHost: string; value: string } | null;
	/** Present whenever the offer is made. */
	vmcNote: string | null;
	vmcRequiredReceivers: readonly string[];
	/** Literal `false`: BIMI is never required. */
	readonly required: false;
	/** Literal `false`: the offer is never re-surfaced as an unresolved task. */
	readonly nag: false;
}

function withheld(reason: BimiIneligibleReason): BimiOffer {
	return {
		offered: false,
		ineligibleReason: reason,
		record: null,
		vmcNote: null,
		vmcRequiredReceivers: BIMI_VMC_REQUIRED_RECEIVERS,
		required: false,
		nag: false,
	};
}

/**
 * BIMI's DMARC precondition, as a REASON: enforcing, and enforcing on ALL of
 * the mail. `null` means eligible. The single source of the rule — the offer
 * builder calls it too, so the wizard's gate and its explanation can never
 * disagree.
 */
export function bimiIneligibleReason(input: {
	dmarcPolicy?: DmarcPolicy;
	dmarcPct?: number;
}): BimiIneligibleReason | null {
	const policy = input.dmarcPolicy ?? 'none';
	if (policy !== 'quarantine' && policy !== 'reject') return 'dmarc_policy_below_quarantine';
	if (input.dmarcPct !== undefined && input.dmarcPct < 100) return 'dmarc_pct_below_100';
	return null;
}

/** Convenience predicate over {@link bimiIneligibleReason}. */
export function isBimiEligible(input: { dmarcPolicy?: DmarcPolicy; dmarcPct?: number }): boolean {
	return bimiIneligibleReason(input) === null;
}

/**
 * Build the BIMI offer for one sending domain (a per-stream subdomain is an
 * ordinary sending domain here — BIMI is evaluated per From domain, so each
 * subdomain that sends gets its own record).
 */
export function offerBimiRecord(input: {
	/** The From domain the record is published for, e.g. `news.example.com`. */
	domain: string;
	/** The zone the operator manages; defaults to the domain's registrable zone. */
	zone?: string;
	dmarcPolicy?: DmarcPolicy;
	dmarcPct?: number;
	/** HTTPS URL of the SVG Tiny PS logo. */
	logoUrl?: string;
	/** HTTPS URL of the VMC PEM, when the operator has bought one. */
	vmcUrl?: string;
	selector?: string;
}): BimiOffer {
	const reason = bimiIneligibleReason(input);
	if (reason !== null) return withheld(reason);

	const selector = input.selector?.trim() || BIMI_DEFAULT_SELECTOR;
	const host = `${selector}._bimi.${input.domain}`;
	const logoUrl = input.logoUrl?.trim();
	const vmcUrl = input.vmcUrl?.trim();

	const record =
		logoUrl === undefined || logoUrl === ''
			? null
			: {
					type: 'TXT' as const,
					host,
					relativeHost: zoneRelativeHost(host, input.zone ?? input.domain),
					value:
						vmcUrl === undefined || vmcUrl === ''
							? `v=BIMI1; l=${logoUrl};`
							: `v=BIMI1; l=${logoUrl}; a=${vmcUrl};`,
				};

	return {
		offered: true,
		ineligibleReason: null,
		record,
		vmcNote: BIMI_VMC_NOTE,
		vmcRequiredReceivers: BIMI_VMC_REQUIRED_RECEIVERS,
		required: false,
		nag: false,
	};
}
