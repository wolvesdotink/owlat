import { convexTest } from 'convex-test';
import { describe, it, expect, vi, afterEach } from 'vitest';
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

const ENV_KEYS = [
	'EMAIL_PROVIDER',
	'MTA_API_URL',
	'MTA_API_KEY',
	'RESEND_API_KEY',
	'AWS_SES_ACCESS_KEY_ID',
	'AWS_SES_SECRET_ACCESS_KEY',
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

describe('delivery.status.sendTest — staged diagnostics', () => {
	it('stops at provider configuration when no transport is usable', async () => {
		setEnv({});
		const t = convexTest(schema, modules);
		const result = await t.action(api.delivery.status.sendTest, { to: 'admin@example.com' });

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
		const result = await t.action(api.delivery.status.sendTest, { to: 'not-an-email' });

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
		const result = await t.action(api.delivery.status.sendTest, { to: 'admin@example.com' });

		expect(result.success).toBe(true);
		expect(result.provider).toBe('mta');
		expect(result.providerMessageId).toBe('test-message-1');
		expect(result.attempts).toBe(1);
		expect(result.stages.every((stage) => stage.status === 'passed')).toBe(true);
	});
});
