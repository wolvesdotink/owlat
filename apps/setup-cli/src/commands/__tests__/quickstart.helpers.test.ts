import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlags, dnsInstructions, formatSummary, resolveComposeVersionPin } from '../quickstart.js';
import { mergeEnv, readEnv, writeEnv } from '../../lib/env.js';
import type { SetupConfig } from '../../lib/setupConfig.js';

describe('resolveComposeVersionPin', () => {
	it('pins the resolved semver on the release (pull) path so signed images deploy', () => {
		expect(resolveComposeVersionPin({ owlatVersion: '1.2.3' })).toBe('1.2.3');
		// prerelease semver is still a published tag
		expect(resolveComposeVersionPin({ owlatVersion: '2.0.0-rc.1' })).toBe('2.0.0-rc.1');
	});

	it('pins the `dev` sentinel for local-source installs (build/local-images)', () => {
		expect(resolveComposeVersionPin({ buildLocal: true })).toBe('dev');
		expect(resolveComposeVersionPin({ localImages: true })).toBe('dev');
		// build/local mode wins even when a version is also present
		expect(resolveComposeVersionPin({ buildLocal: true, owlatVersion: '1.2.3' })).toBe('dev');
	});

	it('leaves OWLAT_VERSION unset (undefined) for a branch/main/commit ref — no matching immutable tag', () => {
		expect(resolveComposeVersionPin({})).toBeUndefined();
		expect(resolveComposeVersionPin({ owlatVersion: 'main' })).toBeUndefined();
		expect(resolveComposeVersionPin({ owlatVersion: '' })).toBeUndefined();
		expect(resolveComposeVersionPin({ owlatVersion: '  ' })).toBeUndefined();
		expect(resolveComposeVersionPin({ owlatVersion: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })).toBeUndefined();
	});

	it('a non-buildLocal (release) quickstart leaves a concrete, non-"dev" OWLAT_VERSION in the generated .env', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'owlat-pin-'));
		const envPath = join(dir, '.env');
		await writeEnv(envPath, { SOME_OTHER: 'keep-me' });

		// Mirror the production write path in runQuickstart for the pull install.
		const pin = resolveComposeVersionPin({ owlatVersion: '1.2.3' });
		expect(pin).toBeDefined();
		await writeEnv(envPath, mergeEnv(await readEnv(envPath), { OWLAT_VERSION: pin! }));

		const env = await readEnv(envPath);
		expect(env['OWLAT_VERSION']).toBe('1.2.3');
		expect(env['OWLAT_VERSION']).not.toBe('dev');
		// existing keys are preserved (not clobbered)
		expect(env['SOME_OTHER']).toBe('keep-me');

		// and the literal `:dev` sentinel never lands in the file
		expect(await readFile(envPath, 'utf-8')).not.toMatch(/OWLAT_VERSION=dev/);
	});
});

describe('parseFlags', () => {
	it('parses --key value pairs', () => {
		expect(parseFlags(['--mode', 'blank', '--email', 'a@b.com'])).toEqual({
			mode: 'blank',
			email: 'a@b.com',
		});
	});

	it('parses --key=value form', () => {
		expect(parseFlags(['--mode=populated', '--name=Jane'])).toEqual({
			mode: 'populated',
			name: 'Jane',
		});
	});

	it('rejects an invalid --mode value instead of propagating it', () => {
		expect(parseFlags(['--mode', 'yolo'])).toEqual({});
	});

	it('maps the seed toggles to their booleans', () => {
		expect(parseFlags(['--no-seed'])).toEqual({ skipSeed: true });
		expect(parseFlags(['--seed'])).toEqual({ forceSeed: true });
	});

	it('ignores positional arguments', () => {
		expect(parseFlags(['quickstart', '--email', 'a@b.com'])).toEqual({ email: 'a@b.com' });
	});
});

describe('dnsInstructions', () => {
	it('returns nothing without a network config (local install)', () => {
		expect(dnsInstructions({} as SetupConfig)).toEqual([]);
	});

	it('lists an A record per public hostname', () => {
		const lines = dnsInstructions({
			network: {
				siteUrl: 'https://app.example.com',
				convexUrl: 'https://convex.example.com',
				convexSiteUrl: 'https://convex-site.example.com',
			},
		} as SetupConfig);
		const text = lines.join('\n');
		expect(text).toContain('app.example.com');
		expect(text).toContain('convex.example.com');
		expect(text).toContain('convex-site.example.com');
		expect(text).toContain('TLS certificates are issued automatically');
	});

	it('adds MTA + bounce records when self-sending is configured', () => {
		const lines = dnsInstructions({
			network: {
				siteUrl: 'https://app.example.com',
				convexUrl: 'https://convex.example.com',
				convexSiteUrl: 'https://cs.example.com',
			},
			sending: { provider: 'mta' },
			domain: { ehloHostname: 'mail.example.com', bounceDomain: 'bounces.example.com' },
		} as SetupConfig);
		const text = lines.join('\n');
		expect(text).toContain('mail.example.com');
		expect(text).toMatch(/bounces\.example\.com\s+MX\s+mail\.example\.com/);
	});
});

describe('formatSummary', () => {
	it('tells blank-mode users to register', () => {
		const out = formatSummary({ mode: 'blank', baseUrl: 'http://localhost:3210' });
		expect(out).toContain('/auth/register');
	});

	it('shows the admin email for populated installs', () => {
		const out = formatSummary({ mode: 'populated', adminEmail: 'admin@x.com', baseUrl: 'http://localhost:3210' });
		expect(out).toContain('admin@x.com');
	});

	it('always reminds the operator to back up — command, what it protects, and cadence', () => {
		const out = formatSummary({ mode: 'populated', adminEmail: 'a@b.com', baseUrl: 'http://localhost:3210' });
		// the exact one-off command…
		expect(out).toContain('owlat backup');
		// …and the scheduled-backups command…
		expect(out).toContain('owlat backup-schedule enable');
		// …one line on what it protects (the Convex data volume / database)…
		expect(out.toLowerCase()).toContain('convex data volume');
		// …and the recommended cadence.
		expect(out.toLowerCase()).toContain('daily');
	});

	it('shows the backup reminder even in blank mode (it must always appear)', () => {
		const out = formatSummary({ mode: 'blank', baseUrl: 'http://localhost:3210' });
		expect(out).toContain('owlat backup');
		expect(out).toContain('owlat backup-schedule enable');
	});
});
