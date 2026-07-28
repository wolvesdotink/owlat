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

import { isDnsLabel, trySplitZone, zoneRelativeHost } from '@owlat/shared/dnsZone';
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

/** An operator-supplied URL the offer could not put in a published record. */
export type BimiRejectedInput = 'logoUrl' | 'vmcUrl';

/**
 * Accept a URL only if it can be published verbatim inside a BIMI TXT value.
 *
 * A BIMI record is `tag=value` pairs separated by `;` and there is no escaping
 * in that grammar, so a value carrying a separator or a space does not round
 * trip: the record the operator pastes stops meaning what the screen showed
 * them. The scheme is checked too — BIMI requires HTTPS for both the logo and
 * the VMC. Anything else returns `null` and the caller DEGRADES to no record
 * rather than throwing: this is a rendering surface, and the screen must survive
 * the value it exists to help the operator fix.
 */
export function publishableBimiUri(raw: string | undefined): string | null {
	const trimmed = raw?.trim() ?? '';
	// Printable ASCII only, which rules out every space, tab, newline and control
	// character in one predicate; `;` is excluded separately for legibility.
	if (trimmed === '' || !/^[\x21-\x7e]+$/.test(trimmed) || trimmed.includes(';')) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	return parsed.protocol === 'https:' ? trimmed : null;
}

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
	/**
	 * URLs the operator supplied that could not be published as given. Named so
	 * the wizard can say WHICH value to fix instead of silently showing nothing
	 * — and so a rejected VMC never quietly ships a logo-only record the operator
	 * believes carries their certificate.
	 */
	rejectedInputs: BimiRejectedInput[];
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
		rejectedInputs: [],
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

	// A selector is a DNS LABEL and is interpolated into a record host. Anything
	// that is not one (a space, a slash, a leading hyphen) falls back to the
	// spec's `default` rather than producing a host nothing can name: this is a
	// rendering surface, and it degrades instead of blowing up the screen the
	// operator is using to fix the value.
	const candidate = input.selector?.trim() ?? '';
	const selector = isDnsLabel(candidate) ? candidate : BIMI_DEFAULT_SELECTOR;
	const host = `${selector}._bimi.${input.domain}`;

	// Same rule one level up: a domain with no registrable zone has no
	// zone-relative form, so the offer shows the absolute host instead of throwing.
	const relativeHost =
		trySplitZone(input.domain) === null ? host : zoneRelativeHost(host, input.domain);

	const suppliedLogo = input.logoUrl?.trim() ?? '';
	const suppliedVmc = input.vmcUrl?.trim() ?? '';
	const logoUrl = publishableBimiUri(suppliedLogo);
	const vmcUrl = publishableBimiUri(suppliedVmc);
	const rejectedInputs: BimiRejectedInput[] = [];
	if (suppliedLogo !== '' && logoUrl === null) rejectedInputs.push('logoUrl');
	if (suppliedVmc !== '' && vmcUrl === null) rejectedInputs.push('vmcUrl');

	// No logo yet ⇒ ask for one rather than emit an empty `l=`. A REJECTED value
	// (either of them) ⇒ no record either: publishing a logo-only record when the
	// VMC was the part we could not use would hand the operator a record that
	// silently does nothing at the two receivers that need the certificate.
	const record =
		logoUrl === null || rejectedInputs.length > 0
			? null
			: {
					type: 'TXT' as const,
					host,
					relativeHost,
					value: vmcUrl === null ? `v=BIMI1; l=${logoUrl};` : `v=BIMI1; l=${logoUrl}; a=${vmcUrl};`,
				};

	return {
		offered: true,
		ineligibleReason: null,
		record,
		rejectedInputs,
		vmcNote: BIMI_VMC_NOTE,
		vmcRequiredReceivers: BIMI_VMC_REQUIRED_RECEIVERS,
		required: false,
		nag: false,
	};
}
