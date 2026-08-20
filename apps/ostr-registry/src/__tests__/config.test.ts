/**
 * Configuration loading. Every assertion here is about failing at startup: a
 * registry that boots with a truncated signing key, a zone origin it cannot
 * render or a cadence of `NaN` seconds is a node that looks healthy and
 * publishes nothing anybody can verify.
 */
import { describe, expect, it } from 'vitest';
import { generateEd25519KeyPair } from '@owlat/ostr-core';
import { DEFAULT_ZONE_ORIGIN, loadConfig, type Environment } from '../config.js';

const logKey = generateEd25519KeyPair().privateKey;
const aggregatorKey = generateEd25519KeyPair().privateKey;
const observerKey = generateEd25519KeyPair().publicKey;

const MINIMAL: Environment = {
	OSTR_LOG_ID: 'log.ostr.example',
	OSTR_LOG_PRIVATE_KEY: logKey,
	OSTR_AGGREGATOR_PRIVATE_KEY: aggregatorKey,
};

function load(overrides: Environment = {}): ReturnType<typeof loadConfig> {
	return loadConfig({ ...MINIMAL, ...overrides });
}

describe('loadConfig', () => {
	it('fills in every default around the three required keys', () => {
		expect(load()).toEqual({
			port: 3300,
			listenAddress: '0.0.0.0',
			// `.data` and not `data`: the repo ignores the dotted form, so following
			// the README's dev command cannot leave a transparency log and its
			// signing state one `git add -A` away from being committed.
			dbDir: './.data',
			logId: 'log.ostr.example',
			logPrivateKeyBase64: logKey,
			aggregatorPrivateKeyBase64: aggregatorKey,
			zoneOrigin: DEFAULT_ZONE_ORIGIN,
			refBaseUrl: `https://${DEFAULT_ZONE_ORIGIN}/s`,
			sthIntervalSeconds: 3600,
			refreshIntervalSeconds: 3600,
			mmdSeconds: 86_400,
			submitRatePerMinute: null,
			logLevel: 'info',
			bootstrapObservers: null,
		});
	});

	it('names the variable that is missing', () => {
		for (const key of ['OSTR_LOG_ID', 'OSTR_LOG_PRIVATE_KEY', 'OSTR_AGGREGATOR_PRIVATE_KEY']) {
			expect(() => load({ [key]: undefined })).toThrow(`${key} is required`);
			// Set-but-blank is the same mistake with a different shape: an unset
			// variable in a compose file interpolates to an empty string.
			expect(() => load({ [key]: '  ' })).toThrow(`${key} is required`);
		}
	});

	it('takes signing keys only as raw 32-byte ed25519 values', () => {
		expect(() => load({ OSTR_LOG_PRIVATE_KEY: 'hunter2' })).toThrow(/OSTR_LOG_PRIVATE_KEY/);
		expect(() =>
			load({ OSTR_AGGREGATOR_PRIVATE_KEY: Buffer.alloc(31).toString('base64') })
		).toThrow(/OSTR_AGGREGATOR_PRIVATE_KEY/);
	});

	it('reads the whole numeric value, or refuses it', () => {
		expect(load({ OSTR_REGISTRY_PORT: '8080' }).port).toBe(8080);
		// An OS-assigned port is legitimate (the tests use it); a garbage one is
		// not, and `parseInt` would have read "8080abc" as 8080.
		expect(load({ OSTR_REGISTRY_PORT: '0' }).port).toBe(0);
		expect(() => load({ OSTR_REGISTRY_PORT: '8080abc' })).toThrow(/OSTR_REGISTRY_PORT/);
		expect(() => load({ OSTR_REGISTRY_PORT: '70000' })).toThrow(/OSTR_REGISTRY_PORT/);
		expect(() => load({ OSTR_STH_INTERVAL_SECONDS: '0' })).toThrow(/OSTR_STH_INTERVAL_SECONDS/);
		expect(() => load({ OSTR_MMD_SECONDS: '-1' })).toThrow(/OSTR_MMD_SECONDS/);
		expect(() => load({ OSTR_REFRESH_INTERVAL_SECONDS: '1.5' })).toThrow(
			/OSTR_REFRESH_INTERVAL_SECONDS/
		);
		expect(load({ OSTR_SUBMIT_RATE_PER_MINUTE: '120' }).submitRatePerMinute).toBe(120);
		expect(() => load({ OSTR_SUBMIT_RATE_PER_MINUTE: '0' })).toThrow(/OSTR_SUBMIT_RATE_PER_MINUTE/);
	});

	it('refuses a head cadence longer than the merge delay it promises', () => {
		// Every promise this node signs would state an MMD shorter than the
		// interval at which a leaf can possibly become covered, so a monitor sees
		// the log in permanent violation from the first submission.
		expect(() => load({ OSTR_STH_INTERVAL_SECONDS: '86400', OSTR_MMD_SECONDS: '3600' })).toThrow(
			/OSTR_STH_INTERVAL_SECONDS.*OSTR_MMD_SECONDS/s
		);
		expect(load({ OSTR_STH_INTERVAL_SECONDS: '3600', OSTR_MMD_SECONDS: '3600' }).mmdSeconds).toBe(
			3600
		);
	});

	it('takes a bind address as an IP literal or localhost, and nothing else', () => {
		expect(load({ OSTR_REGISTRY_LISTEN: '::1' }).listenAddress).toBe('::1');
		expect(load({ OSTR_REGISTRY_LISTEN: 'localhost' }).listenAddress).toBe('localhost');
		// A hostname resolves at bind time, which is after both stores are open
		// and a full refresh has run — far too late to be told about a typo.
		expect(() => load({ OSTR_REGISTRY_LISTEN: 'registry.example' })).toThrow(
			/OSTR_REGISTRY_LISTEN/
		);
		expect(() => load({ OSTR_REGISTRY_LISTEN: 'http://0.0.0.0' })).toThrow(/OSTR_REGISTRY_LISTEN/);
	});

	it('takes a log level pino knows, and refuses one it does not', () => {
		expect(load({ LOG_LEVEL: 'DEBUG' }).logLevel).toBe('debug');
		expect(load({ LOG_LEVEL: 'silent' }).logLevel).toBe('silent');
		expect(() => load({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
	});

	it('derives the evidence-page base from the zone origin, and checks both', () => {
		const config = load({ OSTR_ZONE_ORIGIN: 'OSTR.Example' });

		expect(config.zoneOrigin).toBe('ostr.example');
		expect(config.refBaseUrl).toBe('https://ostr.example/s');
		expect(load({ OSTR_REF_BASE_URL: 'http://localhost:3300/s' }).refBaseUrl).toBe(
			'http://localhost:3300/s'
		);
		expect(() => load({ OSTR_ZONE_ORIGIN: 'not a domain' })).toThrow(/OSTR_ZONE_ORIGIN/);
		expect(() => load({ OSTR_REF_BASE_URL: '/s' })).toThrow(/absolute URL/);
		expect(() => load({ OSTR_REF_BASE_URL: 'ftp://ostr.example/s' })).toThrow(/http\(s\)/);
	});

	it('refuses an evidence base that could break out of the TXT record it lands in', () => {
		// `new URL()` strips CR/LF/TAB while parsing, so this value would have
		// validated and then been published verbatim: the newline ends the TXT
		// record's quoted string and the rest is read as further zone lines — an
		// attacker-chosen apex NS record in this node's zone.
		const injection = 'https://a.example/s\nevil.example. 3600 IN NS attacker.example.\n;';
		expect(() => load({ OSTR_REF_BASE_URL: injection })).toThrow(/control characters/);
		expect(() => load({ OSTR_REF_BASE_URL: 'https://a.example/s\tx' })).toThrow(
			/control characters/
		);

		// Everything that survives is stored parsed, never as typed: a quote in
		// the path is percent-encoded before it can reach zone text.
		expect(load({ OSTR_REF_BASE_URL: 'https://a.example/s"x' }).refBaseUrl).toBe(
			'https://a.example/s%22x'
		);
		expect(load({ OSTR_REF_BASE_URL: 'https://a.example/s/' }).refBaseUrl).toBe(
			'https://a.example/s'
		);
	});

	it('parses the bootstrap allowlist, and treats only an absent one as open submission', () => {
		expect(load().bootstrapObservers).toBeNull();
		// Set-but-blank is an unset compose interpolation, not a decision to open
		// submission. Failing open here silently un-lists every seed observer.
		expect(() => load({ OSTR_BOOTSTRAP_OBSERVERS: '' })).toThrow(/names no observer/);
		expect(() => load({ OSTR_BOOTSTRAP_OBSERVERS: '   ' })).toThrow(/names no observer/);
		expect(
			load({ OSTR_BOOTSTRAP_OBSERVERS: `a.example, b.example=${observerKey}` }).bootstrapObservers
		).toEqual([
			{ domain: 'a.example', records: [] },
			{ domain: 'b.example', records: [`v=1; k=ed25519; p=${observerKey}`] },
		]);
		expect(() => load({ OSTR_BOOTSTRAP_OBSERVERS: 'nope!' })).toThrow(/bootstrap observers/);
	});

	it('refuses a log id that could not be signed into a head as written', () => {
		expect(() => load({ OSTR_LOG_ID: 'log ostr example' })).toThrow(/OSTR_LOG_ID/);
		expect(() => load({ OSTR_LOG_ID: 'x'.repeat(256) })).toThrow(/OSTR_LOG_ID/);
	});
});
