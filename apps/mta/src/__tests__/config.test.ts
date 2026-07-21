import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadConfig, resolveEhloForIp } from '../config.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const REQUIRED_ENV = {
	MTA_API_KEY: 'test-api-key',
	// >= 32 bytes — the boot floor for the secret box that seals DKIM keys at rest.
	MTA_SECRET: 'test-mta-secret-0123456789abcdef0123456789abcdef',
	EHLO_HOSTNAME: 'mail.owlat.com',
	RETURN_PATH_DOMAIN: 'bounces.owlat.com',
	CONVEX_SITE_URL: 'https://test.convex.site',
	MTA_WEBHOOK_SECRET: 'test-secret',
	IP_POOLS_TRANSACTIONAL: '10.0.0.1,10.0.0.2',
	IP_POOLS_CAMPAIGN: '10.0.0.3',
};

describe('loadConfig', () => {
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		// Set all required env vars
		Object.assign(process.env, REQUIRED_ENV);
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	it('throws on missing MTA_API_KEY', () => {
		delete process.env.MTA_API_KEY;
		expect(() => loadConfig()).toThrow('MTA_API_KEY');
	});

	it('throws on missing EHLO_HOSTNAME', () => {
		delete process.env.EHLO_HOSTNAME;
		expect(() => loadConfig()).toThrow('EHLO_HOSTNAME');
	});

	it('throws when MTA_SECRET is missing', () => {
		delete process.env.MTA_SECRET;
		expect(() => loadConfig()).toThrow('MTA_SECRET');
	});

	it('throws when MTA_SECRET is shorter than 32 bytes', () => {
		process.env.MTA_SECRET = 'too-short';
		expect(() => loadConfig()).toThrow('MTA_SECRET must be at least 32 bytes');
	});

	it('exposes a valid MTA_SECRET on the config', () => {
		const config = loadConfig();
		expect(config.mtaSecret).toBe(REQUIRED_ENV.MTA_SECRET);
	});

	it('uses defaults for PORT and REDIS_URL', () => {
		delete process.env.PORT;
		delete process.env.REDIS_URL;

		const config = loadConfig();

		expect(config.port).toBe(3100);
		expect(config.redisUrl).toBe('redis://localhost:6379');
	});

	it('defaults distributed pool coordination to the rolling-upgrade-safe legacy protocol', () => {
		delete process.env.SMTP_POOL_COORDINATION_PROTOCOL;
		expect(loadConfig().smtpPoolCoordinationProtocol).toBe('legacy-v0');
	});

	it('accepts leases-v1 explicitly and rejects unknown pool protocols', () => {
		process.env.SMTP_POOL_COORDINATION_PROTOCOL = 'leases-v1';
		expect(loadConfig().smtpPoolCoordinationProtocol).toBe('leases-v1');
		process.env.SMTP_POOL_COORDINATION_PROTOCOL = 'leases-v2';
		expect(() => loadConfig()).toThrow('SMTP_POOL_COORDINATION_PROTOCOL');
	});

	it('parses IP_POOLS_TRANSACTIONAL as comma-separated', () => {
		process.env.IP_POOLS_TRANSACTIONAL = '10.0.0.1, 10.0.0.2, 10.0.0.3';

		const config = loadConfig();

		expect(config.ipPools.transactional).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
	});

	it('rejects invalid or IPv6 pool entries until the IPv6 delivery phase is enabled', () => {
		process.env.IP_POOLS_TRANSACTIONAL = 'not-an-ip';
		expect(() => loadConfig()).toThrow('not a valid IPv4');
		process.env.IP_POOLS_TRANSACTIONAL = '2001:db8::1';
		expect(() => loadConfig()).toThrow('not a valid IPv4');
	});

	it('defaults to a fail-closed identity gate and parses safe custom PTR suffixes', () => {
		delete process.env.MTA_ALLOW_UNVERIFIED_FCRDNS;
		process.env.MTA_GENERIC_PTR_SUFFIXES = 'static.example-vps.net, customer.host.test ';
		const config = loadConfig();
		expect(config.allowUnverifiedFcrdns).toBe(false);
		expect(config.genericPtrSuffixes).toEqual(['static.example-vps.net', 'customer.host.test']);
	});

	it('accepts only an explicit boolean lab override', () => {
		process.env.MTA_ALLOW_UNVERIFIED_FCRDNS = 'true';
		expect(loadConfig().allowUnverifiedFcrdns).toBe(true);
		process.env.MTA_ALLOW_UNVERIFIED_FCRDNS = 'yes';
		expect(() => loadConfig()).toThrow('must be true or false');
	});

	it('throws on invalid DKIM_KEYS JSON', () => {
		process.env.DKIM_KEYS = 'not-valid-json{{{';
		expect(() => loadConfig()).toThrow('DKIM_KEYS must be valid JSON');
	});

	it('parses valid DKIM_KEYS JSON', () => {
		process.env.DKIM_KEYS = JSON.stringify({
			'owlat.com': { selector: 's1', privateKey: 'pk-test' },
		});

		const config = loadConfig();

		expect(config.dkimKeys['owlat.com']).toEqual({
			selector: 's1',
			privateKey: 'pk-test',
		});
	});

	it('throws when IP pool is empty after filtering', () => {
		process.env.IP_POOLS_TRANSACTIONAL = '  ,  , ';
		expect(() => loadConfig()).toThrow('at least one IP');
	});

	it('refuses to boot when SUBMISSION_ENABLED=true but no TLS cert/key', () => {
		process.env.SUBMISSION_ENABLED = 'true';
		delete process.env.SUBMISSION_TLS_CERT;
		delete process.env.SUBMISSION_TLS_KEY;
		expect(() => loadConfig()).toThrow(/SUBMISSION_TLS_CERT/);
	});

	it('refuses to boot when submission TLS cert is set but key is missing', () => {
		process.env.SUBMISSION_ENABLED = 'true';
		process.env.SUBMISSION_TLS_CERT = 'cert-pem';
		delete process.env.SUBMISSION_TLS_KEY;
		expect(() => loadConfig()).toThrow(/SUBMISSION_TLS_KEY/);
	});

	it('boots with submission enabled when both cert and key are present', () => {
		process.env.SUBMISSION_ENABLED = 'true';
		process.env.SUBMISSION_TLS_CERT = 'cert-pem';
		process.env.SUBMISSION_TLS_KEY = 'key-pem';
		const config = loadConfig();
		expect(config.submissionEnabled).toBe(true);
		expect(config.submissionTlsCert).toBe('cert-pem');
		expect(config.submissionTlsKey).toBe('key-pem');
	});

	it('does not require submission TLS when submission is disabled', () => {
		process.env.SUBMISSION_ENABLED = 'false';
		delete process.env.SUBMISSION_TLS_CERT;
		delete process.env.SUBMISSION_TLS_KEY;
		expect(() => loadConfig()).not.toThrow();
	});

	it('exposes submission brute-force defaults', () => {
		delete process.env.SUBMISSION_MAX_CONNECTIONS_PER_IP;
		delete process.env.SUBMISSION_MAX_CLIENTS;
		delete process.env.SUBMISSION_MAX_AUTH_FAILURES_PER_IP;
		const config = loadConfig();
		expect(config.submissionMaxConnectionsPerIp).toBe(10);
		expect(config.submissionMaxClients).toBe(200);
		expect(config.submissionMaxAuthFailuresPerIp).toBe(10);
	});

	// ── PR-63 item 2: EHLO_HOSTNAME FQDN validation ──
	describe('EHLO_HOSTNAME FQDN validation', () => {
		it("rejects 'localhost'", () => {
			process.env.EHLO_HOSTNAME = 'localhost';
			expect(() => loadConfig()).toThrow('EHLO_HOSTNAME');
		});

		it("rejects a bare hostname like 'mta1'", () => {
			process.env.EHLO_HOSTNAME = 'mta1';
			expect(() => loadConfig()).toThrow('EHLO_HOSTNAME');
		});

		it("rejects a raw IP literal like '203.0.113.10'", () => {
			process.env.EHLO_HOSTNAME = '203.0.113.10';
			expect(() => loadConfig()).toThrow('EHLO_HOSTNAME');
		});

		it('rejects whitespace-containing values', () => {
			process.env.EHLO_HOSTNAME = 'mail.example.com ';
			expect(() => loadConfig()).toThrow('EHLO_HOSTNAME');
			process.env.EHLO_HOSTNAME = 'mail .example.com';
			expect(() => loadConfig()).toThrow('EHLO_HOSTNAME');
		});

		it("accepts a valid FQDN like 'mail.example.com'", () => {
			process.env.EHLO_HOSTNAME = 'mail.example.com';
			expect(() => loadConfig()).not.toThrow();
			expect(loadConfig().ehloHostname).toBe('mail.example.com');
		});
	});

	// ── PR-63 item 1: per-IP EHLO hostname map ──
	describe('EHLO_HOSTNAMES per-IP map', () => {
		it('defaults to an empty map when unset', () => {
			delete process.env.EHLO_HOSTNAMES;
			expect(loadConfig().ehloHostnames).toEqual({});
		});

		it('parses a JSON IP→hostname map', () => {
			process.env.EHLO_HOSTNAMES = JSON.stringify({
				'10.0.0.1': 'mail1.example.com',
				'10.0.0.2': 'mail2.example.com',
			});
			expect(loadConfig().ehloHostnames).toEqual({
				'10.0.0.1': 'mail1.example.com',
				'10.0.0.2': 'mail2.example.com',
			});
		});

		it('throws on invalid JSON', () => {
			process.env.EHLO_HOSTNAMES = 'not-json{{{';
			expect(() => loadConfig()).toThrow('EHLO_HOSTNAMES must be valid JSON');
		});

		it('throws when a mapped name is not a valid FQDN', () => {
			process.env.EHLO_HOSTNAMES = JSON.stringify({ '10.0.0.1': 'localhost' });
			expect(() => loadConfig()).toThrow('EHLO_HOSTNAMES');
		});
	});
});

// ── PR-63 item 1: resolveEhloForIp ──
describe('resolveEhloForIp', () => {
	const config = {
		ehloHostname: 'fallback.example.com',
		ehloHostnames: {
			'10.0.0.1': 'mail1.example.com',
			'10.0.0.2': 'mail2.example.com',
		},
	};

	it('returns the mapped name for a mapped IP', () => {
		expect(resolveEhloForIp(config, '10.0.0.1')).toBe('mail1.example.com');
		expect(resolveEhloForIp(config, '10.0.0.2')).toBe('mail2.example.com');
	});

	it('falls back to the global ehloHostname for an unmapped IP', () => {
		expect(resolveEhloForIp(config, '10.0.0.9')).toBe('fallback.example.com');
	});

	it('falls back when the map is empty', () => {
		expect(
			resolveEhloForIp({ ehloHostname: 'only.example.com', ehloHostnames: {} }, '1.2.3.4')
		).toBe('only.example.com');
	});
});

describe('.env.example coverage', () => {
	it('documents every env var config.ts reads (keeps .env.example in sync)', () => {
		const configSrc = readFileSync(resolve(HERE, '../config.ts'), 'utf-8');
		const envExample = readFileSync(resolve(HERE, '../../.env.example'), 'utf-8');

		// Env keys config.ts reads via requiredEnv('X') / optionalEnv('X', …) / process.env['X'].
		const read = new Set(
			[
				...configSrc.matchAll(
					/(?:requiredEnv|optionalEnv)\('([A-Z][A-Z0-9_]+)'|process\.env\['([A-Z][A-Z0-9_]+)'\]/g
				),
			]
				.map((m) => m[1] ?? m[2])
				.filter((k): k is string => Boolean(k))
		);

		// Keys documented in .env.example (live `KEY=` or commented `# KEY=`).
		const documented = new Set(
			[...envExample.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1])
		);

		const missing = [...read].filter((k) => !documented.has(k)).sort();
		expect(missing).toEqual([]);
	});
});
