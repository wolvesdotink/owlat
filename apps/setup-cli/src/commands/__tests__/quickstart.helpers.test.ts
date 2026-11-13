import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { parseFlags, dnsInstructions, formatSummary } from '../quickstartPrompts.js';
import { resolveComposeVersionPin, composeImageSource, composeUpArgs } from '../quickstartStack.js';
import { checkOutboundPort25, outboundPort25Warning } from '../quickstartOutbound.js';
import type { MtaHealthBody } from '../doctor.js';
import { doctorText } from '../../lib/doctorText.js';
import { localSiteUrlNotice } from '../../lib/publicSiteUrl.js';
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
		expect(
			resolveComposeVersionPin({ owlatVersion: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
		).toBeUndefined();
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

describe('compose bring-up image source', () => {
	it('never builds on the host when the desktop preloaded the images (local-push)', () => {
		const source = composeImageSource({ localImages: true });
		expect(source).toBe('preloaded');
		expect(composeUpArgs(source)).toEqual(['compose', 'up', '-d', '--no-build']);
	});

	it('builds from source for a local-build install, and leaves the default alone otherwise', () => {
		expect(composeUpArgs(composeImageSource({ buildLocal: true }))).toEqual([
			'compose',
			'up',
			'-d',
			'--build',
		]);
		expect(composeImageSource({ buildLocal: true, localImages: true })).toBe('build');
		expect(composeUpArgs(composeImageSource({}))).toEqual(['compose', 'up', '-d']);
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

	it('parses the explicit checkpoint restart flag', () => {
		expect(parseFlags(['--restart'])).toEqual({ restart: true });
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

	it('spells out the PTR record and where it is set', () => {
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
		expect(text).toMatch(/PTR\s+mail\.example\.com/);
		expect(text).toContain("VPS provider's console");
	});
});

describe('formatSummary', () => {
	it('tells blank-mode users to register', () => {
		const out = formatSummary({ mode: 'blank', baseUrl: 'http://localhost:3210' });
		expect(out).toContain('/auth/register');
	});

	it('shows the admin email for populated installs', () => {
		const out = formatSummary({
			mode: 'populated',
			adminEmail: 'admin@x.com',
			baseUrl: 'http://localhost:3210',
		});
		expect(out).toContain('admin@x.com');
	});

	it('always reminds the operator to back up — command, what it protects, and cadence', () => {
		const out = formatSummary({
			mode: 'populated',
			adminEmail: 'a@b.com',
			baseUrl: 'http://localhost:3210',
		});
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

/**
 * The closing summary after the port-25 probe. Most VPS providers block
 * outbound TCP/25 on new accounts; an install that ends on "Quickstart
 * complete!" there leaves mail queued with no hint why. A probe that could not
 * run says nothing, so it never alarms an install that is fine.
 */
describe('quickstart — outbound port 25 in the summary', () => {
	const plain = (s: string) => stripVTControlCharacters(s);
	const headline = (out: string) => plain(out).split('\n')[0];
	const mtaEnv = { EMAIL_PROVIDER: 'mta', MTA_HTTP_PORT: '3100' };
	const blockedHealth = {
		ok: true as const,
		body: {
			smtpOutbound: {
				status: 'degraded',
				targetMx: 'mx.example.net',
				ips: [{ ip: '203.0.113.10', status: 'failed', reason: 'timeout' }],
			},
		},
	};

	it('reports a blocked port in plain words, with both ways out and the guide', async () => {
		const fetchHealth = vi.fn(async () => blockedHealth);
		const result = await checkOutboundPort25(mtaEnv, fetchHealth);
		expect(fetchHealth).toHaveBeenCalledWith('http://localhost:3100');
		expect(result).toEqual({ status: 'blocked', ips: ['203.0.113.10'] });

		const warning = outboundPort25Warning(result, mtaEnv).join('\n');
		expect(warning).toContain('Outbound port 25 is blocked from 203.0.113.10');
		expect(warning).toContain('ask your hosting provider to unblock outbound port 25');
		expect(warning).toContain('EMAIL_PROVIDER=smtp');
		expect(warning).toContain('https://docs.owlat.app/guide/sending-from-a-vps');
	});

	it('names the VPS provider when the install knows it', () => {
		const warning = outboundPort25Warning(
			{ status: 'blocked', ips: ['203.0.113.10'] },
			{ ...mtaEnv, MTA_VPS_PROVIDER: 'hetzner' }
		).join('\n');
		expect(warning).toContain('Hetzner');
	});

	it('does not print an unqualified success line when the port is blocked', () => {
		const out = formatSummary({
			mode: 'populated',
			adminEmail: 'admin@example.com',
			baseUrl: 'http://localhost:3210',
			outboundWarning: outboundPort25Warning({ status: 'blocked', ips: ['203.0.113.10'] }, mtaEnv),
		});
		expect(headline(out)).not.toBe('Quickstart complete!');
		expect(headline(out)).toContain('port 25 is blocked');
		expect(plain(out)).toContain('Outbound port 25 is blocked from 203.0.113.10');
	});

	it('stays quiet when the MTA health probe could not run', async () => {
		const fetchHealth = vi.fn(async (): Promise<MtaHealthBody> => ({
			ok: false,
			finding: { check: 'mta.health', ok: false, message: doctorText`MTA is unreachable` },
		}));
		const result = await checkOutboundPort25(mtaEnv, fetchHealth);
		expect(result).toEqual({ status: 'unknown' });
		expect(outboundPort25Warning(result, mtaEnv)).toEqual([]);
		const out = formatSummary({
			mode: 'populated',
			baseUrl: 'http://localhost:3210',
			outboundWarning: outboundPort25Warning(result, mtaEnv),
		});
		expect(headline(out)).toBe('Quickstart complete!');
	});

	it('does not probe when the built-in MTA is not the delivery provider', async () => {
		const fetchHealth = vi.fn(async () => blockedHealth);
		const env = { EMAIL_PROVIDER: 'smtp' };
		const result = await checkOutboundPort25(env, fetchHealth);
		expect(fetchHealth).not.toHaveBeenCalled();
		expect(outboundPort25Warning(result, env)).toEqual([]);
	});
});

/**
 * The terminal wizard asks for no public URL, because a public SITE_URL only
 * works together with the reverse proxy and TLS that serve it. The install
 * stays on localhost and works; the summary says where the mail links point
 * and how to move them, once the box sends mail as a public domain.
 */
describe('quickstart — localhost links in system mail', () => {
	const plain = (s: string) => stripVTControlCharacters(s);
	const mailHost = { EHLO_HOSTNAME: 'mail.example.com', DEFAULT_FROM_DOMAIN: 'mail.example.com' };

	it('says the links point at localhost and how to set a public SITE_URL', () => {
		const notice = localSiteUrlNotice({ ...mailHost, SITE_URL: 'http://localhost:3000' });
		const joined = notice.join('\n');
		expect(joined).toContain('http://localhost:3000');
		expect(joined).toMatch(/verification, password-reset and invitation/);
		expect(joined).toContain('owlat env SITE_URL');
		expect(joined).toContain('owlat apply');

		const out = plain(
			formatSummary({ mode: 'custom', baseUrl: 'http://localhost:3210', siteUrlNotice: notice })
		);
		expect(out.split('\n')[0]).toBe('Quickstart complete!');
		expect(out).toContain('owlat env SITE_URL');
	});

	it('stays quiet for a public SITE_URL or a box with no public mail identity', () => {
		expect(localSiteUrlNotice({ ...mailHost, SITE_URL: 'https://owlat.example.com' })).toEqual([]);
		expect(localSiteUrlNotice({ SITE_URL: 'http://localhost:3000' })).toEqual([]);
	});
});
