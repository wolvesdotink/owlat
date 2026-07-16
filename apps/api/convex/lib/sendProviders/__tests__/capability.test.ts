import { convexTest } from 'convex-test';
import { describe, it, expect, afterEach } from 'vitest';
import schema from '../../../schema';
import {
	deliveryConfiguredFromEnv,
	isDeliveryConfigured,
	providerKindConfigured,
} from '../capability';

// convex-test derives its module root from the glob keys; this test lives one
// level deeper than the convex/ root, so the glob walks up three directories.
const modules = import.meta.glob('../../../**/*.*s');

const ENV_KEYS = [
	'EMAIL_PROVIDER',
	'MTA_API_URL',
	'MTA_API_KEY',
	'RESEND_API_KEY',
	'AWS_SES_ACCESS_KEY_ID',
	'AWS_SES_SECRET_ACCESS_KEY',
	'SMTP_RELAY_HOST',
	'SMTP_RELAY_USERNAME',
	'SMTP_RELAY_PASSWORD',
] as const;

const original: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) original[k] = process.env[k];

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
	for (const k of ENV_KEYS) delete process.env[k];
	for (const [k, v] of Object.entries(patch)) {
		if (v !== undefined) process.env[k] = v;
	}
}

async function deliveryConfiguredFromTestEnv(): Promise<boolean> {
	const t = convexTest(schema, modules);
	return await t.run(async (ctx) => await deliveryConfiguredFromEnv(ctx));
}

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (original[k] === undefined) delete process.env[k];
		else process.env[k] = original[k];
	}
});

describe('deliveryConfiguredFromEnv — fail-closed', () => {
	it('returns false when EMAIL_PROVIDER is unset (no implicit mta default)', async () => {
		setEnv({});
		expect(await deliveryConfiguredFromTestEnv()).toBe(false);
	});

	it('returns false for an unrecognized provider kind', async () => {
		setEnv({ EMAIL_PROVIDER: 'sendgrid', RESEND_API_KEY: 're_x' });
		expect(await deliveryConfiguredFromTestEnv()).toBe(false);
	});

	it('mta: requires both MTA_API_URL and MTA_API_KEY', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta' });
		expect(await deliveryConfiguredFromTestEnv()).toBe(false);
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100' });
		expect(await deliveryConfiguredFromTestEnv()).toBe(false);
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		expect(await deliveryConfiguredFromTestEnv()).toBe(true);
	});

	it('resend: requires RESEND_API_KEY', async () => {
		setEnv({ EMAIL_PROVIDER: 'resend' });
		expect(await deliveryConfiguredFromTestEnv()).toBe(false);
		setEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x' });
		expect(await deliveryConfiguredFromTestEnv()).toBe(true);
	});

	it('ses: requires access key id and secret', async () => {
		setEnv({ EMAIL_PROVIDER: 'ses', AWS_SES_ACCESS_KEY_ID: 'AKIA' });
		expect(await deliveryConfiguredFromTestEnv()).toBe(false);
		setEnv({
			EMAIL_PROVIDER: 'ses',
			AWS_SES_ACCESS_KEY_ID: 'AKIA',
			AWS_SES_SECRET_ACCESS_KEY: 'sk',
		});
		expect(await deliveryConfiguredFromTestEnv()).toBe(true);
	});

	it('smtp: requires host, username and password (fail-closed on any missing)', async () => {
		setEnv({ EMAIL_PROVIDER: 'smtp', SMTP_RELAY_HOST: 'smtp.mailgun.org' });
		expect(await deliveryConfiguredFromTestEnv()).toBe(false);
		setEnv({
			EMAIL_PROVIDER: 'smtp',
			SMTP_RELAY_HOST: 'smtp.mailgun.org',
			SMTP_RELAY_USERNAME: 'postmaster',
		});
		expect(await deliveryConfiguredFromTestEnv()).toBe(false);
		setEnv({
			EMAIL_PROVIDER: 'smtp',
			SMTP_RELAY_HOST: 'smtp.mailgun.org',
			SMTP_RELAY_USERNAME: 'postmaster',
			SMTP_RELAY_PASSWORD: 'pw',
		});
		expect(await deliveryConfiguredFromTestEnv()).toBe(true);
	});

	it('providerKindConfigured is the single per-kind cred source', () => {
		setEnv({ RESEND_API_KEY: 're_x' });
		expect(providerKindConfigured('resend')).toBe(true);
		expect(providerKindConfigured('mta')).toBe(false);
	});
});

describe('isDeliveryConfigured — providerRoutes wins, else env', () => {
	it('false when no routes and no env', async () => {
		setEnv({});
		const t = convexTest(schema, modules);
		const ok = await t.run(async (ctx) => isDeliveryConfigured(ctx));
		expect(ok).toBe(false);
	});

	it('true when a providerRoutes row enables a provider whose creds are present', async () => {
		setEnv({ RESEND_API_KEY: 're_x' });
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'transactional',
				strategy: 'single',
				providers: [{ providerType: 'resend', isEnabled: true }],
				createdAt: 0,
				updatedAt: 0,
			});
		});
		const ok = await t.run(async (ctx) => isDeliveryConfigured(ctx));
		expect(ok).toBe(true);
	});

	it('false when the routed provider is enabled but its creds are absent', async () => {
		setEnv({}); // no RESEND_API_KEY
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'single',
				providers: [{ providerType: 'resend', isEnabled: true }],
				createdAt: 0,
				updatedAt: 0,
			});
		});
		const ok = await t.run(async (ctx) => isDeliveryConfigured(ctx));
		expect(ok).toBe(false);
	});

	it('falls back to env when routes exist but none are enabled', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'transactional',
				strategy: 'single',
				providers: [{ providerType: 'resend', isEnabled: false }],
				createdAt: 0,
				updatedAt: 0,
			});
		});
		const ok = await t.run(async (ctx) => isDeliveryConfigured(ctx));
		expect(ok).toBe(true);
	});

	it('message-type aware: a campaign route does not satisfy a transactional gate', async () => {
		// A route for campaigns + provider creds, but no EMAIL_PROVIDER. The
		// message-type-agnostic check is true (some route exists), but a
		// transactional send must NOT pass — its own route resolution would be null.
		setEnv({ RESEND_API_KEY: 're_x' });
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'single',
				providers: [{ providerType: 'resend', isEnabled: true }],
				createdAt: 0,
				updatedAt: 0,
			});
		});
		expect(await t.run(async (ctx) => isDeliveryConfigured(ctx, 'campaign'))).toBe(true);
		expect(await t.run(async (ctx) => isDeliveryConfigured(ctx, 'transactional'))).toBe(false);
		// No message type = "can this instance send at all?" — true (a route exists).
		expect(await t.run(async (ctx) => isDeliveryConfigured(ctx))).toBe(true);
	});
});
