import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { requireOrgPermission } from '../../lib/sessionOrganization';

/**
 * Settings → Delivery status query (`delivery.status.getStatus`).
 *
 * Covers the three contracts that matter for the send-path status page:
 *   1. can-send reflects the real capability check (false when the provider's
 *      required env is missing, true once present);
 *   2. it is admin-gated (`organization:manage`); and
 *   3. it never leaks a credential VALUE — only presence booleans + var names.
 */

// Admin by default; individual tests override with mockRejectedValueOnce to
// exercise the gate. Mirrors the auditLogsRead admin-read coverage pattern.
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
	};
});

// Vite's `import.meta.glob` excludes the directory chain it climbed up through
// to reach the glob base, so `'../../**'` from this `delivery/__tests__` file
// omits the sibling `delivery/*` modules (including `delivery/status.ts`, the
// unit under test). Merge a second glob rooted at `delivery/` and re-prefix its
// keys to the same `../../`-relative form so convex-test resolves every entry.
const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		mod,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

// Seed a member inbox into the roster so the test-send recipient allowlist (the
// org's own userProfiles emails) has something to match. Test sends are
// restricted to member addresses so the diagnostic can't be looped into an open
// relay to arbitrary external victims.
async function seedMember(t: ReturnType<typeof convexTest>, email: string): Promise<void> {
	const now = Date.now();
	await t.run(async (ctx) => {
		await ctx.db.insert('userProfiles', {
			authUserId: `auth-${email}`,
			email,
			createdAt: now,
			updatedAt: now,
		});
	});
}

const ENV_KEYS = [
	'EMAIL_PROVIDER',
	'MTA_API_URL',
	'MTA_API_KEY',
	'RESEND_API_KEY',
	'AWS_SES_REGION',
	'AWS_SES_ACCESS_KEY_ID',
	'AWS_SES_SECRET_ACCESS_KEY',
	'RESEND_WEBHOOK_SECRET',
	'MANDRILL_WEBHOOK_KEY',
] as const;

const original: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) original[k] = process.env[k];
const originalFetch = global.fetch;

function setEnv(patch: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
	for (const k of ENV_KEYS) delete process.env[k];
	for (const [k, value] of Object.entries(patch)) {
		if (value !== undefined) process.env[k] = value;
	}
}

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (original[k] === undefined) delete process.env[k];
		else process.env[k] = original[k];
	}
	global.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('delivery.status.getStatus — can-send', () => {
	it('canSend=false when the provider is mta but MTA_API_URL is missing', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_KEY: 'k' }); // no MTA_API_URL
		const t = convexTest(schema, modules);
		const status = await t.query(api.delivery.status.getStatus, {});

		expect(status.provider).toBe('mta');
		expect(status.isKnownProvider).toBe(true);
		expect(status.canSend).toBe(false);
		expect(status.providerConfigured).toBe(false);
		// The missing var is reported as absent (presence boolean only).
		const url = status.requiredEnv.find((e) => e.name === 'MTA_API_URL');
		expect(url?.isPresent).toBe(false);
	});

	it('canSend=true when mta has both MTA_API_URL and MTA_API_KEY', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		const status = await t.query(api.delivery.status.getStatus, {});

		expect(status.canSend).toBe(true);
		expect(status.providerConfigured).toBe(true);
		expect(status.requiredEnv.every((e) => e.isPresent)).toBe(true);
		expect(status.requiredEnv.map((e) => e.name)).toEqual(['MTA_API_URL', 'MTA_API_KEY']);
	});

	it('canSend=false and no required env listed when EMAIL_PROVIDER is unset', async () => {
		setEnv({});
		const t = convexTest(schema, modules);
		const status = await t.query(api.delivery.status.getStatus, {});

		expect(status.provider).toBeNull();
		expect(status.isKnownProvider).toBe(false);
		expect(status.canSend).toBe(false);
		expect(status.requiredEnv).toEqual([]);
	});
});

describe('delivery.status.getStatus — admin-gated', () => {
	it('rejects when the organization:manage gate denies the caller', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		vi.mocked(requireOrgPermission).mockRejectedValueOnce(new Error('forbidden'));
		await expect(t.query(api.delivery.status.getStatus, {})).rejects.toThrow('forbidden');
	});
});

describe('delivery.status.getStatus — no secret leakage', () => {
	it('never returns a credential value, only presence booleans + var names', async () => {
		const SECRET = 'super-secret-mta-key-DO-NOT-LEAK';
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: SECRET });
		const t = convexTest(schema, modules);
		const status = await t.query(api.delivery.status.getStatus, {});

		// The secret value must not appear anywhere in the serialized response.
		expect(JSON.stringify(status)).not.toContain(SECRET);
		// Each required-env entry exposes only { name, isPresent } — no value field.
		for (const entry of status.requiredEnv) {
			expect(Object.keys(entry).sort()).toEqual(['isPresent', 'name']);
			expect(typeof entry.isPresent).toBe('boolean');
		}
	});
});

describe('delivery.status.getProviderFeedbackStatus', () => {
	it('answers missing configuration for a default or named Resend transport', async () => {
		setEnv({});
		const t = convexTest(schema, modules);
		for (const transportId of ['resend', 'resend#eu']) {
			const status = await t.query(api.delivery.status.getProviderFeedbackStatus, {
				transportId,
			});
			expect(status).toEqual({
				status: 'missing_configuration',
				lastEventAt: null,
				missingVariables: ['RESEND_WEBHOOK_SECRET'],
				ceremony: 'none',
			});
		}
	});

	it('reads only the selected provider source and never returns the secret', async () => {
		const SECRET = 'mandrill-feedback-secret-DO-NOT-LEAK';
		setEnv({ MANDRILL_WEBHOOK_KEY: SECRET });
		const t = convexTest(schema, modules);
		const receivedAt = Date.now();
		await t.run(async (ctx) => {
			await ctx.db.insert('webhookPayloads', {
				source: 'ses',
				rawPayload: 'not-mandrill',
				receivedAt: receivedAt + 1,
			});
			await ctx.db.insert('webhookPayloads', {
				source: 'mandrill',
				rawPayload: SECRET,
				receivedAt,
			});
		});
		const status = await t.query(api.delivery.status.getProviderFeedbackStatus, {
			transportId: 'mandrill',
		});
		expect(status).toEqual({
			status: 'healthy',
			lastEventAt: receivedAt,
			missingVariables: [],
			ceremony: 'signed-webhook',
		});
		expect(JSON.stringify(status)).not.toContain(SECRET);
	});

	it('returns null for an unknown transport kind', async () => {
		const t = convexTest(schema, modules);
		expect(
			await t.query(api.delivery.status.getProviderFeedbackStatus, {
				transportId: 'postmark',
			})
		).toBeNull();
	});
});

describe('delivery.statusActions.sendTest — staged diagnostics', () => {
	it('stops at provider configuration when no transport is usable', async () => {
		setEnv({});
		const t = convexTest(schema, modules);
		const result = await t.action(api.delivery.statusActions.sendTest, { to: 'admin@example.com' });

		expect(result.success).toBe(false);
		expect(result.stages[0]).toMatchObject({
			key: 'provider_configuration',
			status: 'failed',
		});
		expect(result.stages.slice(1).every((stage) => stage.status === 'not_run')).toBe(true);
	});

	it('identifies invalid recipient input before resolving a sender', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const t = convexTest(schema, modules);
		const result = await t.action(api.delivery.statusActions.sendTest, { to: 'not-an-email' });

		expect(result.success).toBe(false);
		expect(result.stages.map((stage) => stage.status)).toEqual([
			'passed',
			'failed',
			'not_run',
			'not_run',
			'not_run',
		]);
	});

	it('returns provider receipt metadata and passes every stage after acceptance', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, id: 'test-message-1' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		) as unknown as typeof fetch;
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seedMember(t, 'admin@example.com');
		const result = await t.action(api.delivery.statusActions.sendTest, { to: 'admin@example.com' });

		expect(result.success).toBe(true);
		expect(result.provider).toBe('mta');
		expect(result.providerMessageId).toBe('test-message-1');
		expect(result.attempts).toBe(1);
		expect(result.stages.every((stage) => stage.status === 'passed')).toBe(true);
	});

	it('rejects a recipient that is not an organization member inbox (no open relay)', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		const sent = vi.fn();
		global.fetch = sent as unknown as typeof fetch;
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seedMember(t, 'admin@example.com');
		const result = await t.action(api.delivery.statusActions.sendTest, {
			to: 'victim@external.example',
		});

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/member address/i);
		// The provider was never contacted for the non-member recipient.
		expect(sent).not.toHaveBeenCalled();
		expect(result.stages.map((stage) => stage.status)).toEqual([
			'passed',
			'failed',
			'not_run',
			'not_run',
			'not_run',
		]);
	});

	it('rate-limits repeated test sends to the same member inbox', async () => {
		setEnv({ EMAIL_PROVIDER: 'mta', MTA_API_URL: 'http://mta:3100', MTA_API_KEY: 'k' });
		global.fetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true, id: 'test-message-1' }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		) as unknown as typeof fetch;
		const t = convexTest(schema, modules);
		rateLimiterTest.register(t);
		await seedMember(t, 'admin@example.com');

		let limited = false;
		for (let i = 0; i < 40; i++) {
			const result = await t.action(api.delivery.statusActions.sendTest, {
				to: 'admin@example.com',
			});
			if (!result.success && /too many/i.test(result.error ?? '')) {
				limited = true;
				break;
			}
		}
		expect(limited).toBe(true);
	});
});
