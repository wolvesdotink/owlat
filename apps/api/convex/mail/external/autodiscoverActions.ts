'use node';

/**
 * Mail-server autodiscovery for the generic IMAP connect form: the network half.
 *
 * The browser cannot do these lookups itself, because the web app's CSP lets it
 * reach no third-party endpoint, so the form asks this action instead. The
 * parsing and URL shapes live in the V8-safe `autodiscover.ts`.
 */

import dns from 'node:dns/promises';
import { v } from 'convex/values';
import { organizationalDomain } from '@owlat/shared/dnsZone';
import { authedAction } from '../../lib/authedFunctions';
import { STRING_LIMITS, validateStringLength } from '../../lib/inputGuards';
import { fetchGuarded, readCappedBytes } from '../../lib/ssrfGuard';
import { assertExternalEnabled } from './externalFeature';
import {
	type DiscoveredMailServers,
	domainAutoconfigUrl,
	ispdbUrl,
	mailDomainOf,
	parseAutoconfigXml,
} from './autodiscover';

// The form waits on this while the user types, so a slow host must not hold it
// for long; the user can always type the servers in.
const FETCH_TIMEOUT_MS = 3000;
// A real autoconfig document is a few kilobytes.
const MAX_AUTOCONFIG_BYTES = 64 * 1024;

/**
 * Fetch and parse one autoconfig document. Every failure is `null`: an
 * unreachable host, a refused (private or redirecting) destination, a non-2xx
 * answer, an oversized body, or a document the parser does not accept.
 */
async function fetchAutoconfig(url: string): Promise<DiscoveredMailServers | null> {
	try {
		const response = await fetchGuarded(url, {
			protocols: ['https:'],
			headers: { accept: 'application/xml, text/xml' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			return null;
		}
		const bytes = await readCappedBytes(response.body, MAX_AUTOCONFIG_BYTES);
		if (!bytes) return null;
		return parseAutoconfigXml(new TextDecoder('utf-8').decode(bytes));
	} catch {
		return null;
	}
}

/**
 * The registrable domain of the domain's preferred MX host, when it differs
 * from the domain itself. A company on a hosted provider rarely has its own
 * ISPDB entry, but the provider behind its MX usually does.
 */
async function mxProviderDomain(domain: string): Promise<string | null> {
	try {
		const records = await dns.resolveMx(domain);
		const preferred = records
			.filter((mx) => mx.exchange)
			.sort((a, b) => a.priority - b.priority)[0];
		if (!preferred) return null;
		const base = organizationalDomain(preferred.exchange.replace(/\.$/, '').toLowerCase());
		return base && base !== domain ? base : null;
	} catch {
		return null;
	}
}

/**
 * Suggest the IMAP and SMTP servers for an address the way mail clients do:
 * the Thunderbird ISP database, then the domain's own autoconfig document, then
 * the ISP database entry of the provider its MX points at. The order is the
 * privacy order too: the domain's own host only learns of the lookup when the
 * shared database has no answer.
 *
 * Fail-soft: `null` for a malformed address or when nothing answers, which the
 * form takes as "the user fills in the servers".
 */
// authz: authenticated member + assertExternalEnabled; fetches public autoconfig
// documents for a domain the caller typed, through the SSRF guard, and reads no
// table.
export const autodiscoverMailServer = authedAction({
	args: { email: v.string() },
	handler: async (ctx, args): Promise<DiscoveredMailServers | null> => {
		await assertExternalEnabled(ctx);
		validateStringLength(args.email, STRING_LIMITS.EMAIL, 'Email address');
		const email = args.email.trim();
		const domain = mailDomainOf(email);
		if (!domain) return null;

		const fromDatabase = await fetchAutoconfig(ispdbUrl(domain));
		if (fromDatabase) return fromDatabase;
		const fromDomain = await fetchAutoconfig(domainAutoconfigUrl(domain, email));
		if (fromDomain) return fromDomain;

		const provider = await mxProviderDomain(domain);
		return provider ? await fetchAutoconfig(ispdbUrl(provider)) : null;
	},
});
