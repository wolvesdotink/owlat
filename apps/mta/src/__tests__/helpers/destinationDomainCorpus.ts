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
	{ domain: 'protonmail.com', provider: 'other', note: 'mailbox provider outside the taxonomy' },
	{ domain: 'comcast.net', provider: 'other', note: 'FBL operator outside the taxonomy' },
	{ domain: 'mail.ru', provider: 'other', note: 'FBL operator outside the taxonomy' },
	{
		domain: 'mail.google.com',
		provider: 'other',
		note: 'custom-tenant Google: deliberately NOT gmail without an MX observation',
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
 * Where each feedback-loop operator's own mailboxes live.
 *
 * `bounce/outcome.ts` maps an ARF `sourceIsp` token onto the SAME cell axis the
 * send was counted in, so the FBL token's cell and the taxonomy's answer for
 * that operator's domain have to be the same key — otherwise a complaint lands
 * in a different cell than the send it complains about. Typed as a total record
 * so a token added to `fblProcessor.isp()` fails the build here too.
 */
export const FBL_OPERATOR_DOMAINS = {
	microsoft: 'outlook.com',
	yahoo: 'yahoo.com',
	aol: 'aol.com',
	google: 'gmail.com',
	comcast: 'comcast.net',
	mailru: 'mail.ru',
} as const satisfies Record<FblSourceIspToken, string>;
