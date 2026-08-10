/**
 * The destination-domain corpus — one fixture, every consumer.
 *
 * D8 gives the destination-provider taxonomy ONE declaration
 * (`@owlat/shared/deliverabilityRouting`). A single declaration only buys
 * agreement if every consumer that turns a recipient domain into a key reaches
 * the same answer, so the domains live here once and
 * `__tests__/destinationTaxonomy.test.ts` drives all of them through each
 * consumer in turn.
 *
 * Cases are pinned as LITERALS rather than derived from
 * `destinationProviderForDomain`: a fixture that computes its own expectation
 * agrees with any taxonomy, including a broken one.
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';
import type { FblSourceIspToken } from '../../bounce/fblProcessor.js';

export interface DestinationDomainCase {
	/** The recipient domain as a consumer receives it. */
	readonly domain: string;
	/** The one key every consumer must agree on for that domain. */
	readonly provider: DestinationProviderKey;
	/** Why the case is in the corpus. */
	readonly note: string;
}

export const DESTINATION_DOMAIN_CORPUS: readonly DestinationDomainCase[] = [
	// ── the named mailbox providers, every alias the taxonomy claims ──────────
	{ domain: 'gmail.com', provider: 'gmail', note: 'consumer Gmail' },
	{ domain: 'googlemail.com', provider: 'gmail', note: 'Gmail alias domain' },
	{ domain: 'outlook.com', provider: 'microsoft', note: 'consumer Outlook' },
	{ domain: 'hotmail.com', provider: 'microsoft', note: 'legacy Hotmail' },
	{ domain: 'live.com', provider: 'microsoft', note: 'legacy Live' },
	{ domain: 'msn.com', provider: 'microsoft', note: 'legacy MSN' },
	{ domain: 'yahoo.com', provider: 'yahoo', note: 'consumer Yahoo' },
	{ domain: 'aol.com', provider: 'yahoo', note: 'AOL is Yahoo-operated' },
	{ domain: 'ymail.com', provider: 'yahoo', note: 'Yahoo alias domain' },
	{ domain: 'yahoo.co.uk', provider: 'yahoo', note: 'Yahoo regional domain' },
	{ domain: 'icloud.com', provider: 'apple', note: 'consumer iCloud' },
	{ domain: 'me.com', provider: 'apple', note: 'legacy MobileMe' },
	{ domain: 'mac.com', provider: 'apple', note: 'legacy .Mac' },

	// ── normalization: the same mailbox provider, spelled differently ─────────
	{ domain: 'GMAIL.COM', provider: 'gmail', note: 'uppercase envelope domain' },
	{ domain: 'Outlook.Com', provider: 'microsoft', note: 'mixed-case envelope domain' },
	{ domain: 'gmail.com.', provider: 'gmail', note: 'fully-qualified trailing-dot form' },

	// ── everything else is `other`, and staying `other` is the contract ───────
	{ domain: 'example.com', provider: 'other', note: 'ordinary custom domain' },
	{
		domain: 'example.com.',
		provider: 'other',
		note: 'unknown operator in fully-qualified trailing-dot form: one operator, one key',
	},
	{ domain: 'protonmail.com', provider: 'other', note: 'mailbox provider outside the taxonomy' },
	{ domain: 'comcast.net', provider: 'other', note: 'FBL operator outside the taxonomy' },
	{ domain: 'mail.ru', provider: 'other', note: 'FBL operator outside the taxonomy' },
	{
		domain: 'acme.example',
		provider: 'other',
		note: 'Google Workspace tenant on its own domain: `other` until an MX observation says otherwise',
	},
	{
		domain: 'mail.google.com',
		provider: 'other',
		note: 'Google-branded HOST that is not a mailbox domain',
	},
	{ domain: 'notgmail.com', provider: 'other', note: 'substring of a named domain, not a match' },
	{
		domain: 'gmail.com.evil.test',
		provider: 'other',
		note: 'adversarial: a named domain as a LABEL of an attacker suffix',
	},
	{ domain: 'googlemail.co', provider: 'other', note: 'adversarial: typo-squat of an alias' },
] as const;

/**
 * One representative MX exchange per taxonomy cell.
 *
 * The warming dimension is NOT labelled from the address domain: the shipped
 * producer is `destinationFromMx`, which classifies from validated MX hostnames
 * (`smtp/destinationProvider.ts`) and hands `providerKey` to the warming effect
 * in `dispatch/effects.ts`. Driving the corpus through that producer is what
 * makes the warming assertions falsifiable — a domain reaches the classifier for
 * real instead of the test computing the cell and handing it back to itself.
 *
 * Keyed by the CELL, not by the domain, so an entry whose address domain is
 * deliberately not its brand (`mail.google.com` is `other`) gets the unknown
 * operator's MX and stays `other` end to end. Total over the taxonomy, so a
 * sixth provider fails the build here too.
 */
export const PROVIDER_MX_EXCHANGES = {
	gmail: 'gmail-smtp-in.l.google.com',
	microsoft: 'owlat-test.mail.protection.outlook.com',
	yahoo: 'mta5.am0.yahoodns.net',
	apple: 'mx01.mail.icloud.com',
	other: 'mx.unknown-operator.example',
} as const satisfies Record<DestinationProviderKey, string>;

/**
 * Where each feedback-loop operator's own mailboxes live — ONE declaration.
 *
 * `bounce/outcome.ts` maps an ARF `sourceIsp` token onto the SAME cell axis the
 * send was counted in, so the FBL token's cell and the taxonomy's answer for
 * that operator's domain have to be the same key — otherwise a complaint lands
 * in a different cell than the send it complains about. Typed as a total record
 * so a token added to `fblProcessor.isp()` fails the build here too.
 *
 * Both suites that make that claim read this table:
 * `__tests__/destinationTaxonomy.test.ts` drives it through the reducer from a
 * synthetic attempt, and `bounce/__tests__/yahooArf.test.ts` drives it through
 * real ARF bytes. Neither carries an operator-domain column of its own — a
 * seventh FBL token gets a domain here, once.
 */
export const FBL_OPERATOR_DOMAINS = {
	microsoft: 'outlook.com',
	yahoo: 'yahoo.com',
	aol: 'aol.com',
	google: 'gmail.com',
	comcast: 'comcast.net',
	mailru: 'mail.ru',
} as const satisfies Record<FblSourceIspToken, string>;
