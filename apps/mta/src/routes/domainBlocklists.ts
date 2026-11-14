/**
 * Domain blocklist lookups for Convex's `domain.blocklist` check
 * (master-key protected). See intelligence/domainBlocklist.ts.
 */

import { Hono } from 'hono';
import { v } from 'convex/values';
import type Redis from 'ioredis';
import type { MtaConfig } from '../config.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import { readJsonBody } from '../lib/jsonBody.js';
import { checkDomainBlocklists } from '../intelligence/domainBlocklist.js';
import { prepareSpamhausAccess } from '../intelligence/dnsblAccess.js';
import { defaultLookupDeps } from '../intelligence/dnsblLookup.js';
import { getDnsblTransport } from '../intelligence/dnsblResolver.js';

/** One sending domain's From, return-path and tracking domains, with room to spare. */
const MAX_DOMAINS = 10;
const DOMAIN_NAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const lookupBody = v.object({ domains: v.array(v.string()) });

export function createDomainBlocklistRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();
	app.use('*', masterKeyAuth(config));

	app.post('/', async (c) => {
		const read = await readJsonBody(c, lookupBody);
		if (!read.ok) return read.response;
		const domains = [...new Set(read.value.domains.map((domain) => domain.toLowerCase()))];
		if (domains.length > MAX_DOMAINS || domains.some((domain) => !DOMAIN_NAME.test(domain))) {
			return c.json({ error: `domains must be at most ${MAX_DOMAINS} domain names` }, 400);
		}
		const transport = getDnsblTransport(config);
		const lookup = { ...defaultLookupDeps, resolve4: transport.resolve4 };
		const results = await checkDomainBlocklists(redis, domains, {
			lookup,
			spamhaus: await prepareSpamhausAccess(redis, lookup),
			now: Date.now,
		});
		return c.json({ results, resolver: transport.configured });
	});

	return app;
}
