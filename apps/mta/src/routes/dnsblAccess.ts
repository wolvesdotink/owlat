/**
 * Blocklist access for the admin card (master-key protected).
 *
 * `GET` reports which resolver blocklist lookups use and whether Spamhaus
 * answered the last sweep. `PUT` sets or clears the Spamhaus DQS key: a key is
 * stored only after its test query answers as listed (see dnsblAccess.ts for
 * why an unverified key is worse than none), and every change starts a fresh
 * sweep so the Outbound IPs card catches up within seconds, not 15 minutes.
 */

import { Hono } from 'hono';
import { v } from 'convex/values';
import type Redis from 'ioredis';
import { DNSBL_LISTS, dnsblZoneHost, isSpamhausDqsKey } from '@owlat/shared/dnsbl';
import type { MtaDnsblAccessUpdate } from '@owlat/mta-protocol/dnsblAccess';
import type { MtaConfig } from '../config.js';
import { masterKeyAuth } from '../auth/masterKeyAuth.js';
import {
	probeSpamhausZone,
	readSpamhausAccess,
	resetSpamhausAccess,
	storeSpamhausDqsKey,
} from '../intelligence/dnsblAccess.js';
import { runDnsblCheck } from '../intelligence/dnsbl.js';
import { defaultLookupDeps } from '../intelligence/dnsblLookup.js';
import { getDnsblTransport } from '../intelligence/dnsblResolver.js';
import { logger } from '../monitoring/logger.js';
import { readJsonBody } from '../lib/jsonBody.js';

const KEY_MESSAGE = 'spamhausDqsKey must be a string or null';
const accessBody = v.object({ spamhausDqsKey: v.union(v.string(), v.null()) });

export function createDnsblAccessRoutes(redis: Redis, config: MtaConfig) {
	const app = new Hono();
	app.use('*', masterKeyAuth(config));

	const transport = () => getDnsblTransport(config);
	const recheck = () => {
		void runDnsblCheck(redis, config).catch(() =>
			logger.error({ operation: 'dnsbl_sweep', category: 'storage' }, 'DNSBL re-check failed')
		);
	};

	app.get('/', async (c) => c.json(await readSpamhausAccess(redis, transport().configured)));

	app.put('/', async (c) => {
		const read = await readJsonBody(c, accessBody, { invalidMessage: KEY_MESSAGE });
		if (!read.ok) return read.response;
		const raw = read.value.spamhausDqsKey;

		if (raw !== null) {
			const key = raw.trim();
			if (!isSpamhausDqsKey(key)) {
				return c.json({ ok: false, reason: 'invalid_key' } satisfies MtaDnsblAccessUpdate, 422);
			}
			const zone = dnsblZoneHost(DNSBL_LISTS.spamhaus, key);
			const rejection = zone
				? await probeSpamhausZone(zone, {
						...defaultLookupDeps,
						resolve4: transport().resolve4,
						quiet: true,
					})
				: 'key_rejected';
			if (rejection) {
				return c.json({ ok: false, reason: rejection } satisfies MtaDnsblAccessUpdate, 422);
			}
			await storeSpamhausDqsKey(redis, key);
		} else {
			await storeSpamhausDqsKey(redis, null);
		}

		// The last sweep's outcome describes the OLD access path; showing it next
		// to the new one would be a lie, so the card reads `pending` until the
		// re-check below lands.
		await resetSpamhausAccess(redis);
		recheck();
		logger.info(
			{ operation: 'dnsbl_access', access: raw === null ? 'public' : 'dqs' },
			'Spamhaus access changed'
		);
		return c.json({
			ok: true,
			access: await readSpamhausAccess(redis, transport().configured),
		} satisfies MtaDnsblAccessUpdate);
	});

	return app;
}
