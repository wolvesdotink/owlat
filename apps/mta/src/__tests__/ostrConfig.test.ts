/**
 * OSTR env parsing in `loadConfig` (plan §12.2).
 *
 * The defaults are the point: an instance that has never heard of the registry
 * must boot with the consumer signal and observer mode OFF, because one leaks
 * its correspondents to an aggregator and the other ships signed header bytes
 * off the box. A malformed value fails the BOOT rather than silently disabling
 * the feature — the runtime fail-open contract covers lookups, not typos.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';

const REQUIRED_ENV = {
	MTA_API_KEY: 'test-api-key',
	MTA_SECRET: 'test-mta-secret-0123456789abcdef0123456789abcdef',
	BOUNCE_VERP_KEY: 'test-bounce-verp-key-0123456789abcdef',
	EHLO_HOSTNAME: 'mail.owlat.com',
	RETURN_PATH_DOMAIN: 'bounces.owlat.com',
	CONVEX_SITE_URL: 'https://test.convex.site',
	MTA_WEBHOOK_SECRET: 'test-secret',
	IP_POOLS_TRANSACTIONAL: '10.0.0.1,10.0.0.2',
	IP_POOLS_CAMPAIGN: '10.0.0.3',
	FBL_DEDUP_PROTOCOL: 'owned-v2',
	FBL_DEDUP_CUTOVER_ACK: 'fresh-install',
};

const OSTR_ENV = [
	'OSTR_ENABLED',
	'OSTR_ZONE',
	'OSTR_AGGREGATOR_URL',
	'OSTR_AGGREGATOR_PUBLIC_KEY',
	'OSTR_OBSERVER_ENABLED',
	'OSTR_LOOKUP_TIMEOUT_MS',
];

describe('loadConfig — OSTR', () => {
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		Object.assign(process.env, REQUIRED_ENV);
		for (const key of OSTR_ENV) delete process.env[key];
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	it('defaults every OSTR switch off', () => {
		const config = loadConfig();
		expect(config.ostrEnabled).toBe(false);
		expect(config.ostrObserverEnabled).toBe(false);
		expect(config.ostrZone).toBeUndefined();
		expect(config.ostrAggregatorUrl).toBeUndefined();
		expect(config.ostrAggregatorPublicKey).toBeUndefined();
		expect(config.ostrLookupTimeoutMs).toBe(2000);
	});

	it('reads the operator opt-in', () => {
		process.env.OSTR_ENABLED = 'true';
		process.env.OSTR_ZONE = 'OSTR.Owlat.App';
		process.env.OSTR_AGGREGATOR_URL = 'https://registry.owlat.app';
		process.env.OSTR_AGGREGATOR_PUBLIC_KEY = 'ed25519:AAAA';
		process.env.OSTR_OBSERVER_ENABLED = 'true';
		process.env.OSTR_LOOKUP_TIMEOUT_MS = '750';

		const config = loadConfig();
		expect(config.ostrEnabled).toBe(true);
		// Query names are built by concatenation, so the zone is normalized once
		// here rather than at every lookup.
		expect(config.ostrZone).toBe('ostr.owlat.app');
		expect(config.ostrAggregatorUrl).toBe('https://registry.owlat.app');
		expect(config.ostrAggregatorPublicKey).toBe('ed25519:AAAA');
		expect(config.ostrObserverEnabled).toBe(true);
		expect(config.ostrLookupTimeoutMs).toBe(750);
	});

	it('treats any value but "true" as off', () => {
		process.env.OSTR_ENABLED = '1';
		process.env.OSTR_OBSERVER_ENABLED = 'yes';
		const config = loadConfig();
		expect(config.ostrEnabled).toBe(false);
		expect(config.ostrObserverEnabled).toBe(false);
	});

	it('rejects a zone that is not a DNS hostname', () => {
		process.env.OSTR_ZONE = 'not a hostname';
		expect(() => loadConfig()).toThrow('OSTR_ZONE must be a DNS hostname');
	});

	it('rejects a non-positive or unparseable lookup timeout', () => {
		process.env.OSTR_LOOKUP_TIMEOUT_MS = '0';
		expect(() => loadConfig()).toThrow('OSTR_LOOKUP_TIMEOUT_MS');
		process.env.OSTR_LOOKUP_TIMEOUT_MS = 'soon';
		expect(() => loadConfig()).toThrow('OSTR_LOOKUP_TIMEOUT_MS');
	});

	it('refuses to boot opted-in with nowhere to ask', () => {
		// The silent failure this replaces: a working MX that produces no tier for
		// any message, forever, and says nothing about why.
		process.env.OSTR_ENABLED = 'true';
		expect(() => loadConfig()).toThrow('OSTR_ENABLED=true requires OSTR_ZONE');
	});

	it('accepts an opt-in with only the snapshot configured — the private path', () => {
		process.env.OSTR_ENABLED = 'true';
		process.env.OSTR_AGGREGATOR_URL = 'https://registry.owlat.app';
		process.env.OSTR_AGGREGATOR_PUBLIC_KEY = 'AAAA';

		const config = loadConfig();
		expect(config.ostrEnabled).toBe(true);
		expect(config.ostrZone).toBeUndefined();
	});

	it('rejects half an aggregator', () => {
		// A snapshot whose signature cannot be checked is not a snapshot, and a key
		// with nowhere to fetch from buys nothing.
		process.env.OSTR_AGGREGATOR_URL = 'https://registry.owlat.app';
		expect(() => loadConfig()).toThrow('required together');

		delete process.env.OSTR_AGGREGATOR_URL;
		process.env.OSTR_AGGREGATOR_PUBLIC_KEY = 'AAAA';
		expect(() => loadConfig()).toThrow('required together');
	});

	it('rejects an aggregator URL that is not http(s)', () => {
		process.env.OSTR_AGGREGATOR_URL = 'registry.owlat.app';
		process.env.OSTR_AGGREGATOR_PUBLIC_KEY = 'AAAA';
		expect(() => loadConfig()).toThrow('OSTR_AGGREGATOR_URL must be an http(s) URL');
	});
});
