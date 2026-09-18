/**
 * Boot-time configuration guards.
 *
 * Both cases here are bugs that reached a live instance and made IMAP
 * unusable/unsafe from the very first install:
 *
 *   • `REDIS_URL` was set on exactly one compose service (mta), so the LOGIN
 *     brute-force limiter had no backing store on every deployment ever made.
 *     The only symptom was one level-40 log line at boot.
 *   • `imap-cert-init` wrote default.key as root:root 0600 while this process
 *     runs as uid 1000 with the volume mounted read-only, so loadConfig threw a
 *     bare `EACCES` that named neither the cause nor the fix. 724 restarts.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

/** Enough env for loadConfig to get past the unrelated required-var checks. */
function baseEnv(): Record<string, string> {
	return {
		CONVEX_URL: 'http://convex:3210',
		CONVEX_ADMIN_KEY: 'admin-key',
	};
}

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedEnv = process.env;
	// A fresh bag, so an ambient REDIS_URL/NODE_ENV on the dev machine or CI
	// runner cannot decide the outcome of a test about missing variables.
	process.env = { ...baseEnv() } as NodeJS.ProcessEnv;
});

afterEach(() => {
	process.env = savedEnv;
});

describe('auth rate limiter configuration', () => {
	it('refuses to boot in production when REDIS_URL is unset', () => {
		process.env['NODE_ENV'] = 'production';

		expect(() => loadConfig()).toThrowError(/REDIS_URL/);
	});

	it('names the opt-out in the refusal, so the message is actionable', () => {
		process.env['NODE_ENV'] = 'production';

		expect(() => loadConfig()).toThrowError(/IMAP_ALLOW_UNTHROTTLED_AUTH=true/);
	});

	it('boots in production once REDIS_URL is wired', () => {
		process.env['NODE_ENV'] = 'production';
		process.env['REDIS_URL'] = 'redis://:pw@redis:6379';

		expect(loadConfig().redisUrl).toBe('redis://:pw@redis:6379');
	});

	it('boots without REDIS_URL when the operator opts out explicitly', () => {
		process.env['NODE_ENV'] = 'production';
		process.env['IMAP_ALLOW_UNTHROTTLED_AUTH'] = 'true';

		expect(loadConfig().redisUrl).toBeNull();
	});

	// The failure direction of this switch is "internet-facing auth port with no
	// brute-force protection", so anything that is not literally `true` is a no.
	it.each(['TRUE', 'True', '1', 'yes', '', 'false'])(
		'does not treat IMAP_ALLOW_UNTHROTTLED_AUTH=%j as an opt-out',
		(value) => {
			process.env['NODE_ENV'] = 'production';
			process.env['IMAP_ALLOW_UNTHROTTLED_AUTH'] = value;

			expect(() => loadConfig()).toThrowError(/REDIS_URL/);
		}
	);

	// `bun dev` has no Redis and no TLS; server.ts gates its own refusal on
	// NODE_ENV the same way, and the two must stay consistent.
	it('only warns outside production, matching the TLS guard in server.ts', () => {
		expect(() => loadConfig()).not.toThrow();
		expect(loadConfig().redisUrl).toBeNull();
	});
});

describe('TLS material from the shared cert volume', () => {
	let certDir: string;

	beforeEach(() => {
		certDir = mkdtempSync(join(tmpdir(), 'owlat-imap-certs-'));
		writeFileSync(join(certDir, 'default.crt'), 'CERT-PEM');
		writeFileSync(join(certDir, 'default.key'), 'KEY-PEM');
		process.env['TLS_CERT_DIR'] = certDir;
	});

	afterEach(() => {
		chmodSync(join(certDir, 'default.key'), 0o600);
		rmSync(certDir, { recursive: true, force: true });
	});

	it('loads default.crt/default.key when they are readable', () => {
		expect(loadConfig().tls).toEqual({ cert: 'CERT-PEM', key: 'KEY-PEM' });
	});

	// Root ignores the permission bits entirely, so this can only be asserted as
	// an unprivileged user — which is exactly how the imap container runs.
	const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

	it.skipIf(asRoot)('explains an unreadable key instead of leaking a bare EACCES', () => {
		// Stand-in for the real defect: the file exists (existsSync passes) but
		// belongs to another uid, so only the read fails.
		chmodSync(join(certDir, 'default.key'), 0o000);

		// The old message was `EACCES: permission denied, open '…/default.key'`
		// and nothing else. Ownership and the read-only mount are the whole story.
		expect(() => loadConfig()).toThrowError(/permission denied/);
		expect(() => loadConfig()).toThrowError(/ownership/);
		expect(() => loadConfig()).toThrowError(/read-only/);
	});

	it.skipIf(asRoot)('keeps the underlying errno error as the cause', () => {
		chmodSync(join(certDir, 'default.key'), 0o000);

		let caught: unknown;
		try {
			loadConfig();
		} catch (err) {
			caught = err;
		}
		expect((caught as Error).cause).toMatchObject({ code: 'EACCES' });
	});
});
