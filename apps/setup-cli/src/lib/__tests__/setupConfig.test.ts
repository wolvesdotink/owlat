import { describe, it, expect } from 'vitest';
import { selectRuntimeEnvVars } from '@owlat/shared/convexRuntimeEnv';
import {
	parseSetupConfig,
	SetupConfigError,
	resolveSetupFlags,
	buildEnvPatchFromConfig,
	buildSetupFromConfig,
	applySetupDefaults,
	type SetupConfig,
} from '../setupConfig';

/** A minimal valid config; tests clone + mutate it. The default flags enable
 * bulk sending (campaigns/transactional), which now requires a delivery
 * provider, so the baseline carries one. */
function base(): Record<string, unknown> {
	return {
		version: 1,
		deploymentMode: 'selfhost',
		features: {},
		sending: { provider: 'mta' },
		admin: { email: 'admin@example.com', name: 'Admin', password: 'longenoughpw!' },
	};
}

function clone<T>(v: T): T {
	return JSON.parse(JSON.stringify(v));
}

describe('parseSetupConfig — happy path', () => {
	it('accepts a minimal config and normalizes features to an object', () => {
		const cfg = parseSetupConfig(base());
		expect(cfg.version).toBe(1);
		expect(cfg.deploymentMode).toBe('selfhost');
		expect(cfg.features).toEqual({});
	});

	it('accepts the full surface (flags, packs, sending, ai, integrations, domain, seedDemo)', () => {
		const raw = {
			...base(),
			features: { flags: { ai: true }, packs: { marketing: true } },
			sending: { provider: 'resend', apiKey: 're_123' },
			ai: { provider: 'openrouter', apiKey: 'sk-or-1' },
			integrations: { googleSafeBrowsingKey: 'gsb', posthog: { host: 'https://ph', apiKey: 'phc_1' } },
			domain: { ehloHostname: 'mail.example.com', bounceDomain: 'bounces.example.com' },
			seedDemo: true,
		};
		const cfg = parseSetupConfig(raw);
		expect(cfg.seedDemo).toBe(true);
		expect(cfg.sending).toEqual({ provider: 'resend', apiKey: 're_123' });
	});
});

describe('parseSetupConfig — rejections (field-named errors)', () => {
	const cases: Array<[string, (c: Record<string, unknown>) => void]> = [
		['version', (c) => (c['version'] = 2)],
		['deploymentMode', (c) => (c['deploymentMode'] = 'cloud')],
		['unknown flag', (c) => (c['features'] = { flags: { notAFlag: true } })],
		['non-boolean flag', (c) => (c['features'] = { flags: { ai: 'yes' } })],
		['unknown pack', (c) => (c['features'] = { packs: { nope: true } })],
		['missing admin', (c) => delete c['admin']],
		['bad email', (c) => ((c['admin'] as Record<string, unknown>)['email'] = 'not-an-email')],
		['short password', (c) => ((c['admin'] as Record<string, unknown>)['password'] = 'short')],
		['bad sending provider', (c) => (c['sending'] = { provider: 'mailgun' })],
		['resend without apiKey', (c) => (c['sending'] = { provider: 'resend' })],
		['ses missing keys', (c) => (c['sending'] = { provider: 'ses', region: 'us-east-1' })],
		['bad ai provider', (c) => (c['ai'] = { provider: 'gemini' })],
		['custom ai missing models', (c) => (c['ai'] = { provider: 'custom', baseUrl: 'x', apiKey: 'y' })],
		['posthog missing apiKey', (c) => (c['integrations'] = { posthog: { host: 'https://ph' } })],
		['domain missing bounce', (c) => (c['domain'] = { ehloHostname: 'mail.x' })],
		['network missing convexUrl', (c) => (c['network'] = { siteUrl: 'https://x', convexSiteUrl: 'https://y' })],
		['non-boolean seedDemo', (c) => (c['seedDemo'] = 'true')],
	];

	for (const [name, mutate] of cases) {
		it(`rejects: ${name}`, () => {
			const c = base();
			mutate(c);
			expect(() => parseSetupConfig(c)).toThrow(SetupConfigError);
		});
	}

	it('rejects a non-object root', () => {
		expect(() => parseSetupConfig(null)).toThrow(SetupConfigError);
		expect(() => parseSetupConfig('nope')).toThrow(SetupConfigError);
	});
});

describe('parseSetupConfig — sending requires a delivery provider', () => {
	it('throws when bulk sending is on (default) but config.sending is absent', () => {
		const c = base();
		delete c['sending'];
		expect(() => parseSetupConfig(c)).toThrow(/config\.sending is required/);
	});

	it('accepts an absent config.sending when every bulk-sending flag is off', () => {
		const c = base();
		delete c['sending'];
		c['features'] = {
			flags: { campaigns: false, transactional: false, automations: false, 'mail.external': true },
		};
		expect(() => parseSetupConfig(c)).not.toThrow();
	});
});

describe('resolveSetupFlags', () => {
	it('returns a fully-resolved boolean map keyed by every flag', () => {
		const flags = resolveSetupFlags(parseSetupConfig(base()));
		expect(Object.keys(flags).length).toBeGreaterThan(0);
		for (const v of Object.values(flags)) expect(typeof v).toBe('boolean');
		expect('campaigns' in flags).toBe(true);
	});

	it('honors an explicit flag override (disabling is monotonic under the cascade)', () => {
		const cfg = parseSetupConfig({ ...base(), features: { flags: { ai: false } } });
		expect(resolveSetupFlags(cfg).ai).toBe(false);
	});
});

describe('buildEnvPatchFromConfig', () => {
	function patch(extra: Record<string, unknown>) {
		return buildEnvPatchFromConfig(parseSetupConfig({ ...base(), ...extra }) as SetupConfig);
	}

	it('maps resend sending to provider + key', () => {
		expect(patch({ sending: { provider: 'resend', apiKey: 're_x' } })).toMatchObject({
			EMAIL_PROVIDER: 'resend',
			RESEND_API_KEY: 're_x',
		});
	});

	it('maps mta sending to just the provider', () => {
		expect(patch({ sending: { provider: 'mta' } })).toEqual({ EMAIL_PROVIDER: 'mta' });
	});

	it('maps ses sending to region + credentials', () => {
		expect(patch({ sending: { provider: 'ses', region: 'eu-west-1', accessKeyId: 'AK', secretAccessKey: 'SK' } })).toEqual({
			EMAIL_PROVIDER: 'ses',
			AWS_SES_REGION: 'eu-west-1',
			AWS_SES_ACCESS_KEY_ID: 'AK',
			AWS_SES_SECRET_ACCESS_KEY: 'SK',
		});
	});

	it('maps openrouter ai to the dual LLM_/OPENROUTER_ keys', () => {
		expect(patch({ ai: { provider: 'openrouter', apiKey: 'k' } })).toEqual({
			EMAIL_PROVIDER: 'mta',
			LLM_PROVIDER: 'openrouter',
			LLM_API_KEY: 'k',
			OPENROUTER_API_KEY: 'k',
		});
	});

	it('maps custom ai to base url + models', () => {
		expect(
			patch({ ai: { provider: 'custom', baseUrl: 'https://api/v1', apiKey: 'k', modelFast: 'fast', modelCapable: 'cap' } }),
		).toEqual({
			EMAIL_PROVIDER: 'mta',
			LLM_PROVIDER: 'custom',
			LLM_BASE_URL: 'https://api/v1',
			LLM_API_KEY: 'k',
			LLM_MODEL_FAST: 'fast',
			LLM_MODEL_CAPABLE: 'cap',
		});
	});

	it('maps integrations + domain', () => {
		expect(
			patch({
				integrations: { googleSafeBrowsingKey: 'gsb', posthog: { host: 'https://ph', apiKey: 'phc' } },
				domain: { ehloHostname: 'mail.x', bounceDomain: 'bounces.x' },
			}),
		).toEqual({
			EMAIL_PROVIDER: 'mta',
			GOOGLE_SAFE_BROWSING_API_KEY: 'gsb',
			POSTHOG_API_KEY: 'phc',
			POSTHOG_HOST: 'https://ph',
			NUXT_PUBLIC_POSTHOG_API_KEY: 'phc',
			NUXT_PUBLIC_POSTHOG_HOST: 'https://ph',
			EHLO_HOSTNAME: 'mail.x',
			RETURN_PATH_DOMAIN: 'bounces.x',
			// From-identity derived off the configured EHLO domain.
			DEFAULT_FROM_DOMAIN: 'mail.x',
			DEFAULT_FROM_EMAIL: 'noreply@mail.x',
			DEFAULT_FROM_NAME: 'Owlat',
		});
	});

	it('maps the public network URLs', () => {
		expect(
			patch({ network: { siteUrl: 'https://owlat.x.com', convexUrl: 'https://convex.x.com', convexSiteUrl: 'https://convex-site.x.com' } }),
		).toEqual({
			EMAIL_PROVIDER: 'mta',
			SITE_URL: 'https://owlat.x.com',
			NUXT_PUBLIC_SITE_URL: 'https://owlat.x.com',
			NUXT_PUBLIC_CONVEX_URL: 'https://convex.x.com',
			NUXT_PUBLIC_CONVEX_SITE_URL: 'https://convex-site.x.com',
			CONVEX_SITE_URL: 'https://convex-site.x.com',
		});
	});

	it('emits only the baseline provider for omitted optional sections', () => {
		// base() carries sending:{provider:'mta'}, which the env patch reflects.
		expect(patch({})).toEqual({ EMAIL_PROVIDER: 'mta' });
	});
});

describe('buildSetupFromConfig', () => {
	it('produces secrets, deployment markers, defaults, and echoes admin/seed', () => {
		const cfg = parseSetupConfig({ ...base(), sending: { provider: 'mta' } });
		const out = buildSetupFromConfig(cfg, {});
		expect(out.env['BETTER_AUTH_SECRET']).toBeTruthy();
		expect(out.env['INSTANCE_SECRET']).toMatch(/^[0-9a-f]{64}$/);
		expect(out.env['OWLAT_DEPLOYMENT_MODE']).toBe('selfhost');
		expect(out.env['OWLAT_HOSTED_MODE']).toBe('false');
		expect(out.env['OWLAT_DEV_MODE']).toBe('false'); // selfhost stays fail-closed
		expect(out.env['SITE_URL']).toBe('http://localhost:3000');
		expect(out.env['CONVEX_SITE_URL']).toBe('http://localhost:3211');
		expect(out.env['EMAIL_PROVIDER']).toBe('mta');
		expect(out.admin).toEqual(cfg.admin);
		expect(out.seedDemo).toBe(false);
		expect(out.hosted).toBe(false);
	});

	it('enables dev mode for the dev deployment mode', () => {
		const out = buildSetupFromConfig(parseSetupConfig({ ...base(), deploymentMode: 'dev' }), {});
		expect(out.env['OWLAT_DEV_MODE']).toBe('true');
	});

	it('marks hosted mode for the hosted deployment mode', () => {
		const out = buildSetupFromConfig(parseSetupConfig({ ...base(), deploymentMode: 'hosted' }), {});
		expect(out.env['OWLAT_HOSTED_MODE']).toBe('true');
		expect(out.hosted).toBe(true);
	});

	it('merges over existing env without clobbering operator edits', () => {
		const out = buildSetupFromConfig(parseSetupConfig(base()), {
			SITE_URL: 'https://my.host',
			CUSTOM_KEY: 'keep-me',
			BETTER_AUTH_SECRET: 'preexisting',
		});
		expect(out.env['SITE_URL']).toBe('https://my.host'); // default did not override
		expect(out.env['CUSTOM_KEY']).toBe('keep-me');
		expect(out.env['BETTER_AUTH_SECRET']).toBe('preexisting'); // ensureSecrets preserves
	});

	it('honors seedDemo from the config', () => {
		const out = buildSetupFromConfig(parseSetupConfig({ ...clone(base()), seedDemo: true }), {});
		expect(out.seedDemo).toBe(true);
	});

	it('public network URLs override the localhost defaults', () => {
		const cfg = parseSetupConfig({
			...base(),
			network: { siteUrl: 'https://owlat.x.com', convexUrl: 'https://convex.x.com', convexSiteUrl: 'https://convex-site.x.com' },
		});
		const out = buildSetupFromConfig(cfg, {});
		expect(out.env['SITE_URL']).toBe('https://owlat.x.com');
		expect(out.env['NUXT_PUBLIC_CONVEX_URL']).toBe('https://convex.x.com');
		expect(out.env['NUXT_PUBLIC_CONVEX_SITE_URL']).toBe('https://convex-site.x.com');
		expect(out.env['CONVEX_SITE_URL']).toBe('https://convex-site.x.com');
	});
});

/**
 * Regression: the send-path env. The default (mta) install completed but could
 * send no mail — not even its own auth/password-reset mail — because the TS
 * setup path never gave MTA_API_URL a value, so `selectRuntimeEnvVars` (which
 * skips empty values) dropped it and it was never pushed into the Convex
 * deployment. ALL system/auth mail routes through the instance MTA regardless of
 * EMAIL_PROVIDER, so MTA_API_URL must reach the runtime for resend/ses too.
 */
describe('send-path env reaches the Convex runtime', () => {
	/** Build the env a config would produce and keep only the runtime keys that
	 * `selectRuntimeEnvVars` would actually push into the deployment. */
	function runtimeEnv(extra: Record<string, unknown>, existing: Record<string, string> = {}): Record<string, string> {
		const out = buildSetupFromConfig(parseSetupConfig({ ...base(), ...extra }), existing).env;
		return Object.fromEntries(selectRuntimeEnvVars(out));
	}

	it('default (mta) install pushes MTA_API_URL + a non-empty MTA_API_KEY', () => {
		const runtime = runtimeEnv({ sending: { provider: 'mta' } });
		expect(runtime['MTA_API_URL']).toBe('http://mta:3100');
		expect(runtime['MTA_INTERNAL_URL']).toBe('http://mta:3100');
		expect(runtime['MTA_API_KEY']).toMatch(/^mta_/);
		expect(runtime['MTA_API_KEY']!.length).toBeGreaterThan(4);
	});

	it('a resend install STILL pushes MTA_API_URL (auth-mail reachability)', () => {
		const runtime = runtimeEnv({ sending: { provider: 'resend', apiKey: 're_x' } });
		expect(runtime['EMAIL_PROVIDER']).toBe('resend');
		expect(runtime['RESEND_API_KEY']).toBe('re_x');
		expect(runtime['MTA_API_URL']).toBe('http://mta:3100');
		expect(runtime['MTA_API_KEY']).toMatch(/^mta_/);
	});

	it('an ses install STILL pushes MTA_API_URL (auth-mail reachability)', () => {
		const runtime = runtimeEnv({
			sending: { provider: 'ses', region: 'eu-west-1', accessKeyId: 'AK', secretAccessKey: 'SK' },
		});
		expect(runtime['EMAIL_PROVIDER']).toBe('ses');
		expect(runtime['MTA_API_URL']).toBe('http://mta:3100');
		expect(runtime['MTA_API_KEY']).toMatch(/^mta_/);
	});

	it('derives DEFAULT_FROM_* off the configured EHLO domain and pushes them', () => {
		const runtime = runtimeEnv({ domain: { ehloHostname: 'mail.example.com', bounceDomain: 'bounces.example.com' } });
		expect(runtime['DEFAULT_FROM_DOMAIN']).toBe('mail.example.com');
		expect(runtime['DEFAULT_FROM_EMAIL']).toBe('noreply@mail.example.com');
		expect(runtime['DEFAULT_FROM_NAME']).toBe('Owlat');
	});

	it('passes an operator-supplied DEFAULT_FROM_DOMAIN through to the runtime', () => {
		const runtime = runtimeEnv({ sending: { provider: 'mta' } }, { DEFAULT_FROM_DOMAIN: 'mail.acme.test' });
		expect(runtime['DEFAULT_FROM_DOMAIN']).toBe('mail.acme.test');
	});

	it('never clobbers an operator-supplied MTA_API_URL', () => {
		const runtime = runtimeEnv({ sending: { provider: 'mta' } }, { MTA_API_URL: 'http://mta.internal:9100' });
		expect(runtime['MTA_API_URL']).toBe('http://mta.internal:9100');
	});

	it('pushes MAIL_SYNC_API_URL + a non-empty MAIL_SYNC_API_KEY when mail.external is on', () => {
		// Regression: enabling external mailboxes (mail.external) gave the Convex
		// runtime no MAIL_SYNC_API_URL, so selectRuntimeEnvVars dropped the empty
		// key and mail/outbound.ts saved outbound external mail to Sent but never
		// dispatched it. The worker listens on mail-sync:3200 (docker-compose.yml).
		const runtime = runtimeEnv({ features: { flags: { 'mail.external': true } } });
		expect(runtime['MAIL_SYNC_API_URL']).toBe('http://mail-sync:3200');
		expect(runtime['MAIL_SYNC_API_KEY']).toMatch(/^msk_/);
		expect(runtime['MAIL_SYNC_API_KEY']!.length).toBeGreaterThan(4);
	});

	it('does NOT push MAIL_SYNC_API_URL when mail.external is off', () => {
		const runtime = runtimeEnv({ sending: { provider: 'mta' } });
		expect(runtime['MAIL_SYNC_API_URL']).toBeUndefined();
	});

	it('never clobbers an operator-supplied MAIL_SYNC_API_URL', () => {
		const runtime = runtimeEnv(
			{ features: { flags: { 'mail.external': true } } },
			{ MAIL_SYNC_API_URL: 'http://mail-sync.internal:9200' },
		);
		expect(runtime['MAIL_SYNC_API_URL']).toBe('http://mail-sync.internal:9200');
	});
});

describe('applySetupDefaults', () => {
	it('sets URLs + closed dev mode for selfhost', () => {
		const env: Record<string, string> = {};
		applySetupDefaults(env, 'selfhost');
		expect(env['OWLAT_DEV_MODE']).toBe('false');
		expect(env['NUXT_PUBLIC_CONVEX_URL']).toBe('http://localhost:3210');
	});

	it('defaults the in-cluster MTA URLs for all providers', () => {
		const env: Record<string, string> = {};
		applySetupDefaults(env, 'selfhost');
		expect(env['MTA_API_URL']).toBe('http://mta:3100');
		expect(env['MTA_INTERNAL_URL']).toBe('http://mta:3100');
	});

	it('never overrides an operator-supplied MTA_API_URL', () => {
		const env: Record<string, string> = { MTA_API_URL: 'http://mta.internal:9100' };
		applySetupDefaults(env, 'selfhost');
		expect(env['MTA_API_URL']).toBe('http://mta.internal:9100');
	});

	it('opens dev mode for dev', () => {
		const env: Record<string, string> = {};
		applySetupDefaults(env, 'dev');
		expect(env['OWLAT_DEV_MODE']).toBe('true');
	});

	it('never overrides values already present', () => {
		const env: Record<string, string> = { OWLAT_DEV_MODE: 'true', SITE_URL: 'https://x' };
		applySetupDefaults(env, 'selfhost');
		expect(env['OWLAT_DEV_MODE']).toBe('true');
		expect(env['SITE_URL']).toBe('https://x');
	});
});
