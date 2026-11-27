/**
 * `domain.blocklist`: are the domains this sending domain's mail names on a
 * domain blocklist (Spamhaus DBL, SURBL, URIBL)?
 *
 * The lookups run on the MTA (`POST /domain-blocklists`), not here: they have
 * to leave from the server's own recursive resolver (`DNSBL_RESOLVER`), because
 * every one of these lists refuses the shared resolvers a Convex deployment
 * uses, and the MTA already holds the Spamhaus DQS key, the lookup retry
 * budget and a cache that keeps a sweep from bursting queries at the lists.
 * The lists name registered domains, so each host is asked as its registered
 * domain, once.
 */

import { DELIVERABILITY_NOT_MEASURED } from '@owlat/shared';
import {
	DOMAIN_BLOCKLISTS,
	isDnsblUnknownReason,
	isDomainBlocklistId,
	type DnsblUnknownReason,
	type DomainBlocklistId,
} from '@owlat/shared/dnsbl';
import { organizationalDomain } from '@owlat/shared/spfAlignment';
import { isRecord } from '@owlat/shared/utils/guards';
import { getMtaConfig, mtaFetch } from '../mail/mtaClient';
import { returnPathProviderFor } from '../domains/returnPathProviders';
import {
	checklistObservation,
	inconclusiveObservation,
	type ChecklistObservation,
	type ChecklistVerificationContext,
} from './checklistValidatorTypes';

/** The MTA spaces its lookups; a cold cache can take a few of them. */
const LOOKUP_TIMEOUT_MS = 45_000;

const VALIDATOR = 'mta.domain-blocklist';

const UNKNOWN_GUIDANCE: Record<DnsblUnknownReason, string> = {
	resolver_refused:
		'refused to answer the resolver the mail server asked through. Point DNSBL_RESOLVER at the bundled recursive resolver, or add a Spamhaus DQS key for Spamhaus DBL.',
	rate_limited:
		'answered that this resolver sends too many queries. Point DNSBL_RESOLVER at the bundled recursive resolver so queries leave from this server only.',
	resolver_unreachable: 'did not answer. The mail server checks again on the next sweep.',
	unusable_answer:
		'gave an answer Owlat cannot read, usually a resolver that rewrites answers. Point DNSBL_RESOLVER at the bundled recursive resolver.',
	key_rejected:
		'was not asked: the Spamhaus DQS key failed its test query. Check the key under Blocklist lookups.',
};

interface LookupResult {
	domain: string;
	list: DomainBlocklistId;
	status: 'listed' | 'clean' | 'unknown';
	reason?: DnsblUnknownReason;
}

function readResults(body: unknown): LookupResult[] | null {
	if (!isRecord(body) || !Array.isArray(body['results'])) return null;
	const results: LookupResult[] = [];
	for (const entry of body['results']) {
		if (!isRecord(entry)) return null;
		const { domain, list, status, reason } = entry;
		if (
			typeof domain !== 'string' ||
			typeof list !== 'string' ||
			!isDomainBlocklistId(list) ||
			(status !== 'listed' && status !== 'clean' && status !== 'unknown')
		) {
			return null;
		}
		results.push({ domain, list, status, ...(isDnsblUnknownReason(reason) ? { reason } : {}) });
	}
	return results;
}

/** The registered domains this sending domain's mail names, each once. */
function blocklistDomainsFor(context: ChecklistVerificationContext): string[] {
	const domain = context.domain!;
	const returnPath = returnPathProviderFor(domain.providerType)?.activeHost(
		domain.domain,
		domain.returnPathHost?.toLowerCase().replace(/\.$/, '')
	);
	const tracking = context.tracking
		.filter(
			(row) =>
				row.isVerified && (row.domain === domain.domain || row.domain.endsWith(`.${domain.domain}`))
		)
		.map((row) => row.domain);
	const hosts = [domain.domain, ...(returnPath ? [returnPath] : []), ...tracking];
	return [...new Set(hosts.map((host) => organizationalDomain(host.toLowerCase())))];
}

export async function observeDomainBlocklists(
	context: ChecklistVerificationContext,
	providerValues: string[]
): Promise<ChecklistObservation> {
	const domain = context.domain!;
	if (domain.status !== 'verified') {
		return checklistObservation(
			VALIDATOR,
			'warn',
			`Owlat checks ${domain.domain} against domain blocklists once it is verified.`,
			providerValues
		);
	}
	const mta = getMtaConfig();
	if (!mta) {
		return checklistObservation(
			VALIDATOR,
			'warn',
			'Domain blocklists are checked through the built-in mail server’s resolver, and this deployment does not run one.',
			[...providerValues, DELIVERABILITY_NOT_MEASURED]
		);
	}
	const domains = blocklistDomainsFor(context);
	let results: LookupResult[] | null = null;
	try {
		const response = await mtaFetch(
			mta,
			'/domain-blocklists',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ domains }),
			},
			LOOKUP_TIMEOUT_MS
		);
		results = response.ok ? readResults(await response.json()) : null;
	} catch {
		results = null;
	}
	if (!results) {
		return inconclusiveObservation(
			VALIDATOR,
			'The mail server did not answer the domain blocklist lookup. Owlat checks again on the next sweep.',
			[...providerValues, 'lookup=unanswered']
		);
	}
	const observed = [
		...providerValues,
		...results.map(
			(result) =>
				`${result.domain}:${result.list}=${result.status}${result.reason ? `:${result.reason}` : ''}`
		),
	];
	const listed = results.filter((result) => result.status === 'listed');
	if (listed.length > 0) {
		return checklistObservation(
			VALIDATOR,
			'fail',
			listed
				.map(
					(result) =>
						`${result.domain} is listed on ${DOMAIN_BLOCKLISTS[result.list].name}; ask for removal at ${DOMAIN_BLOCKLISTS[result.list].delistingUrl}.`
				)
				.join(' ') +
				' Receivers junk mail that names a listed domain, whatever the sending address.',
			observed
		);
	}
	const unknown = results.filter((result) => result.status === 'unknown');
	if (unknown.length > 0) {
		return inconclusiveObservation(
			VALIDATOR,
			[
				...new Set(
					unknown.map(
						(result) =>
							`${DOMAIN_BLOCKLISTS[result.list].name} ${UNKNOWN_GUIDANCE[result.reason ?? 'resolver_unreachable']}`
					)
				),
			].join(' '),
			observed
		);
	}
	return checklistObservation(
		VALIDATOR,
		'pass',
		`No domain blocklist names ${domains.join(', ')}.`,
		observed
	);
}
