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
 * Both layers are module scope, so neither calls `useI18n`: `lead` and every
 * `point` is a catalog KEY, and the disclosure resolves them with `t()` at
 * render time. `label` is the transport's NAME — a key for the two kinds this
 * surface words itself, the catalog's own label otherwise — and goes through the
 * same boundary, which leaves a name that is not a key untouched.
 *
 * Pure and DOM-free so both layers are unit-testable without mounting anything;
 * `DomainDnsGuidance.vue` is the disclosure that renders the result. The
 * capability layer is exported for the same reason: it is the branch no shipped
 * kind reaches today (all five carry an override), so the only thing that can
 * prove it right before provider N+1 arrives is a test that calls it.
 */

import { type DeliveryProviderKind, isDeliveryProviderKind } from '@owlat/shared';
import {
	domainVerificationOf,
	type SendProviderCatalogEntryShape,
} from '@owlat/shared/sendProviderCatalog';
import { transportKindLabel } from '~/utils/transportState';
import { composedSendProviderCatalogEntry } from '~/utils/composedSendProviderCatalog';

export interface TransportDnsGuidance {
	/** The transport's name, as the delivery surface words it. */
	label: string;
	/** Catalog key for the opening line. */
	lead: string;
	/** Catalog keys, one per bullet. */
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
			lead: 'shared.transportDnsGuidance.own.lead',
			points: [
				'shared.transportDnsGuidance.own.records',
				'shared.transportDnsGuidance.own.signing',
			],
		};
	}
	if (domainVerificationOf(entry) === 'api') {
		return {
			lead: 'shared.transportDnsGuidance.api.lead',
			points: [
				'shared.transportDnsGuidance.api.records',
				'shared.transportDnsGuidance.api.verification',
				'shared.transportDnsGuidance.api.dmarc',
			],
		};
	}
	return {
		lead: 'shared.transportDnsGuidance.none.lead',
		points: [
			'shared.transportDnsGuidance.none.setupGuide',
			'shared.transportDnsGuidance.none.confirm',
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
		lead: 'shared.transportDnsGuidance.ses.lead',
		points: ['shared.transportDnsGuidance.ses.dkim', 'shared.transportDnsGuidance.ses.spf'],
	},
	smtp: {
		lead: 'shared.transportDnsGuidance.smtp.lead',
		points: [
			'shared.transportDnsGuidance.smtp.setupGuide',
			'shared.transportDnsGuidance.smtp.confirm',
		],
	},
	resend: {
		lead: 'shared.transportDnsGuidance.resend.lead',
		points: [
			'shared.transportDnsGuidance.resend.records',
			'shared.transportDnsGuidance.resend.dmarc',
		],
	},
	// Three items, not two — and the third is the one that surprises people. A
	// domain with flawless SPF and DKIM but no completed ownership check is one
	// Mandrill still rejects (`unsigned`). The EXACT records are derived from the
	// domain name and rendered right below this card by the Mandrill status
	// panel, which is why this entry points at them instead of restating a DKIM
	// key that would immediately be a second copy.
	mandrill: {
		lead: 'shared.transportDnsGuidance.mandrill.lead',
		points: [
			'shared.transportDnsGuidance.mandrill.records',
			'shared.transportDnsGuidance.mandrill.verification',
			'shared.transportDnsGuidance.mandrill.dmarc',
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
	entry: SendProviderCatalogEntryShape | undefined = composedSendProviderCatalogEntry(
		kind ?? undefined
	)
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
