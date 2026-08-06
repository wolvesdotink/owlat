/**
 * PER-TRANSPORT DNS GUIDANCE — what an operator has to publish, and prove, for
 * the transport that is actually live.
 *
 * Two layers, and the order matters (the seams plan's D5):
 *
 *  1. the CAPABILITY paragraph, derived from the catalog entry. `tier: 'own'`
 *     and `domainVerification` between them answer "how does this domain become
 *     mine for sending?" for any transport, including one that does not exist
 *     yet — which is what stops a new provider from rendering a blank card (or,
 *     as the exhaustive table this replaced did, a compile error in a file
 *     outside its bundle);
 *  2. the per-vendor OVERRIDE, which is the prose each incumbent earned. The
 *     catalog states that it deliberately does not carry copy like this, so it
 *     lives here — optional, so a kind with none still renders.
 *
 * Pure and DOM-free so both layers are unit-testable without mounting anything;
 * `DomainDnsGuidance.vue` is the disclosure that renders the result. The
 * capability layer is exported for the same reason: it is the branch no shipped
 * kind reaches today (all five carry an override), so the only thing that can
 * prove it right before provider N+1 arrives is a test that calls it.
 */

import { type DeliveryProviderKind, isDeliveryProviderKind } from '@owlat/shared';
import {
	coreSendProviderCatalogEntry,
	domainVerificationOf,
	type SendProviderCatalogEntryShape,
} from '@owlat/shared/sendProviderCatalog';
import { transportKindLabel } from '~/utils/transportState';

export interface TransportDnsGuidance {
	/** The transport's name, as the delivery surface words it. */
	label: string;
	lead: string;
	points: string[];
}

type Guidance = Pick<TransportDnsGuidance, 'lead' | 'points'>;

/**
 * WHAT A TRANSPORT WITHOUT ITS OWN PARAGRAPH SAYS, keyed by the capability that
 * decides it.
 *
 *  - `own`  our own MTA — the one identity D3 calls definitional. It publishes
 *           managed records for the domain, so the guidance is about adding
 *           what this app already shows, not about a third party's console. It
 *           is a separate branch rather than a `domainVerification: 'none'`
 *           reading, because "your provider handles SPF and DKIM for you" is
 *           actively wrong for the transport that IS you.
 *  - `api`  the provider has an identity API the domain is registered with, so
 *           ownership is a real step, separate from (and after) the DNS.
 *  - `none` the transport publishes nothing about the domain: the records are
 *           the provider's own to document, and we say so rather than inventing
 *           a verification step it does not have.
 */
export function capabilityDnsGuidance(
	entry: Pick<SendProviderCatalogEntryShape, 'tier' | 'domainVerification'>
): Guidance {
	if (entry.tier === 'own') {
		return {
			lead: 'Owlat manages the DNS for you.',
			points: [
				'The SPF, DKIM, and DMARC records shown for each domain below are the managed records — add them exactly as displayed, then verify.',
				'Once verified, Owlat signs your mail as your domain automatically.',
			],
		};
	}
	if (domainVerificationOf(entry) === 'api') {
		return {
			lead: 'Your provider verifies this domain through its own identity API.',
			points: [
				'Publish the SPF and DKIM records your provider shows for this domain, exactly as displayed.',
				'Then complete the provider’s own domain verification. Until that clears, it can reject mail from this domain no matter how good the DNS is.',
				'Keep a DMARC record on the domain so receivers can check that SPF or DKIM aligns; your existing policy stays authoritative.',
			],
		};
	}
	return {
		lead: 'Your provider handles SPF and DKIM for you.',
		points: [
			'Follow your provider’s setup guide to add their SPF include and DKIM records for this domain.',
			'Then confirm two things: your domain’s SPF authorizes the provider, and mail from it carries a DKIM signature that validates for your domain.',
		],
	};
}

/**
 * The wording each shipped transport earned — plain language, deliberately no
 * DNS generation: the records themselves are rendered below the card (the own
 * MTA, Mandrill) or live in the provider's own console (SES, Resend, a relay).
 *
 * OVERRIDES, not the mechanism. The own MTA has no row: the copy it used to
 * carry IS the `own` branch above, word for word, because that branch is about
 * the arm rather than about a vendor.
 */
const GUIDANCE: Partial<Record<DeliveryProviderKind, Guidance>> = {
	ses: {
		lead: 'SES signs your mail with its own DKIM identity tokens.',
		points: [
			'In the SES console, open Verified identities → your domain → and add the three DKIM CNAME records SES generates for the identity.',
			'Keep an SPF record that authorizes SES (include amazonses.com) and a DMARC record so receivers can check alignment.',
		],
	},
	smtp: {
		lead: 'Your relay provider handles SPF and DKIM for you.',
		points: [
			'Follow your provider’s setup guide to add their SPF include and DKIM records for this domain.',
			'Then confirm two things: your domain’s SPF authorizes the relay, and mail from the relay carries a DKIM signature that validates for your domain.',
		],
	},
	resend: {
		lead: 'Resend signs your mail once your domain is verified there.',
		points: [
			'In the Resend dashboard, add the SPF and DKIM records it shows for this domain.',
			'A DMARC record on top lets receivers check that SPF or DKIM aligns with your domain.',
		],
	},
	// Three items, not two — and the third is the one that surprises people. A
	// domain with flawless SPF and DKIM but no completed ownership check is one
	// Mandrill still rejects (`unsigned`). The EXACT records are derived from the
	// domain name and rendered right below this card by the Mandrill status
	// panel, which is why this entry points at them instead of restating a DKIM
	// key that would immediately be a second copy.
	mandrill: {
		lead: 'Mailchimp Transactional signs with one shared key, so your records are the same every time.',
		points: [
			'Publish the two records shown under “Mailchimp Transactional sending domains” below: the SPF include that authorizes Mandrill’s IPs, and the DKIM TXT at mandrill._domainkey. They are derived from your domain name, so they are exactly what Owlat registered.',
			'Then complete Mandrill’s own domain verification — the TXT token shown beside the records, or the confirmation flow in Settings → Domains → Sending Domains. Until that clears, Mandrill rejects mail from this domain no matter how good the DNS is.',
			'Keep a DMARC record on the domain so receivers can check that SPF or DKIM aligns; your existing policy stays authoritative.',
		],
	},
};

/**
 * The guidance for the ACTIVE transport, or `null` when there is no transport
 * this build can speak for (unset, or an `EMAIL_PROVIDER` the catalog does not
 * declare — the card then renders nothing rather than guessing).
 *
 * `entry` is injectable so the capability layer can be exercised for a provider
 * that does not exist yet, which is the only way to prove that layer before
 * provider N+1 relies on it.
 */
export function transportDnsGuidance(
	kind: string | null | undefined,
	entry: SendProviderCatalogEntryShape | undefined = coreSendProviderCatalogEntry(kind ?? undefined)
): TransportDnsGuidance | null {
	if (entry === undefined) return null;
	const declared = isDeliveryProviderKind(entry.kind);
	// A declared kind is named the way the whole delivery surface names it; an
	// injected one can only be named by the entry that was handed in.
	const label = declared ? transportKindLabel(entry.kind) : entry.label;
	return {
		label,
		...((declared ? GUIDANCE[entry.kind] : undefined) ?? capabilityDnsGuidance(entry)),
	};
}
