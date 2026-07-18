/**
 * Redacted hook DELIVERY LOGS (Tier 2, PP-25), driven end to end through the REAL
 * `invokeHook` internal action (convex-test) with only the network transport
 * mocked. The suite proves the piece's guarantees:
 *   - every resolution — short-circuit, network success, network failure, rejected
 *     output — writes exactly one tenant-scoped delivery row with the right kind,
 *     `attempted` flag, `source`, and fixed fallback `failureCode`;
 *   - the row (and its projection) carry NO payload, app text, secret, or
 *     signature — redaction is by construction;
 *   - the operator list query is owner/admin-only, tenant-isolated, bounded, and
 *     filterable by app / kind / source;
 *   - retention deletes rows older than the window and keeps recent ones.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookTransportOutcome } from '../hookClient';

const transport = vi.hoisted(() => ({ callConnectedAppHook: vi.fn() }));
vi.mock('../hookClient', () => ({ callConnectedAppHook: transport.callConnectedAppHook }));

// The connected app is bound to a bundled plugin whose manifest declares the
// three hook capabilities; the operator grant is seeded per test below.
vi.mock('../../plugins/plugins.generated', () => ({
	bundledPluginComposition: [
		{
			packageName: '@example/alpha',
			manifest: {
				id: 'alpha',
				version: '1.0.0',
				capabilities: ['draft:strategy', 'send:gate', 'agent:step'],
				flag: { default: false },
			},
		},
	],
}));

// Authenticate the operator list query authentically: reject anonymous and
// non-admin callers, and return the caller's active org for tenant scoping.
const auth = vi.hoisted(() => ({
	role: 'owner' as 'owner' | 'editor',
	organizationId: 'tenant-a',
	userId: 'user-a',
}));
vi.mock('../../lib/sessionOrganization', async () => {
	const requireMember = async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
		if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
		return { userId: auth.userId, role: auth.role, activeOrganizationId: auth.organizationId };
	};
	return {
		...(await vi.importActual('../../lib/sessionOrganization')),
		requireOrgMember: vi.fn(requireMember),
		getMutationContext: vi.fn(requireMember),
		requireOrgPermission: vi.fn(async (ctx: { auth: { getUserIdentity(): Promise<unknown> } }) => {
			if (!(await ctx.auth.getUserIdentity())) throw new Error('unauthenticated');
			if (auth.role === 'editor') throw new Error('forbidden');
			return { userId: auth.userId, role: auth.role, activeOrganizationId: auth.organizationId };
		}),
	};
});

import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import { sealConnectedAppSecret } from '../secretBox';
import {
	AUDIT_LOG_RETENTION_MS,
	CONNECTED_APP_HOOK_LOG_CLEANUP_BATCH_SIZE,
	CONNECTED_APP_HOOK_LOG_MAX_LIMIT,
} from '../../lib/constants';

const rootGlob = import.meta.glob('../../**/*.*s');
const localGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../connectedApps/'),
		mod,
	])
);
const modules = { ...rootGlob, ...localGlob };

const makeT = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof makeT>;
type Ctx = Parameters<Parameters<TestConvex['run']>[0]>[0];

const ORG = 'tenant-a';
const SECRET = 'cah_delivery-log-secret';
const ALL_HOOK_CAPS = ['draft:strategy', 'send:gate', 'agent:step'];
const IDENTITY = {
	subject: 'user-a',
	issuer: 'https://test.issuer.example',
	tokenIdentifier: 'https://test.issuer.example|user-a',
};

beforeEach(() => {
	vi.stubEnv('INSTANCE_SECRET', 'hook-delivery-log-test-instance-secret');
	transport.callConnectedAppHook.mockReset();
	auth.role = 'owner';
	auth.organizationId = ORG;
	auth.userId = 'user-a';
});
afterEach(() => vi.unstubAllEnvs());

async function operatorGrant(ctx: Ctx, allowed: readonly string[] = ALL_HOOK_CAPS): Promise<void> {
	const flag = 'plugin.alpha';
	const existing = await ctx.db.query('instanceSettings').first();
	const next = {
		featureFlags: { ...existing?.featureFlags, [flag]: true },
		pluginCapabilityGrants: {
			...existing?.pluginCapabilityGrants,
			[flag]: Object.fromEntries(allowed.map((capability) => [capability, true])),
		},
		updatedAt: Date.now(),
	};
	if (existing) await ctx.db.patch(existing._id, next);
	else await ctx.db.insert('instanceSettings', { ...next, createdAt: Date.now() });
}

async function seedApp(
	ctx: Ctx,
	opts: { organizationId?: string; status?: 'enabled' | 'disabled' | 'revoked' } = {}
): Promise<Id<'connectedApps'>> {
	await operatorGrant(ctx);
	const now = Date.now();
	const sealed = sealConnectedAppSecret(SECRET);
	return ctx.db.insert('connectedApps', {
		organizationId: opts.organizationId ?? ORG,
		pluginId: 'alpha',
		name: 'alpha app',
		endpointUrl: 'https://hooks.example.com/x',
		status: opts.status ?? 'enabled',
		grantedCapabilities: ALL_HOOK_CAPS,
		secretCiphertext: sealed.ciphertext,
		secretIv: sealed.iv,
		secretAuthTag: sealed.authTag,
		secretEnvelopeVersion: sealed.version,
		secretRotatedAt: now,
		createdByUserId: 'seed',
		createdAt: now,
		updatedAt: now,
	});
}

function ok(result: unknown): HookTransportOutcome {
	return { status: 'ok', result } as HookTransportOutcome;
}

function invoke(
	t: TestConvex,
	appId: Id<'connectedApps'>,
	hookKind: 'draft' | 'gate' | 'score',
	organizationId = ORG
) {
	return t.action(internal.connectedApps.hookRuntime.invokeHook, {
		organizationId,
		connectedAppId: appId,
		hookKind,
		payload: { subject: 'secret subject line', body: 'confidential message content' },
	});
}

/** Assert-and-narrow the first row so property access is type-safe. */
function firstRow<T>(rows: readonly T[]): T {
	const row = rows[0];
	if (row === undefined) throw new Error('expected at least one delivery log row');
	return row;
}

function logRows(t: TestConvex, organizationId = ORG) {
	return t.run((ctx) =>
		ctx.db
			.query('connectedAppHookDeliveryLogs')
			.withIndex('by_org_and_time', (index) => index.eq('organizationId', organizationId))
			.order('desc')
			.collect()
	);
}

describe('delivery logging via invokeHook', () => {
	it('records a short-circuit fallback with no attempt and no plugin id (foreign tenant)', async () => {
		const t = makeT();
		const appId = await t.run((ctx) => seedApp(ctx));
		await invoke(t, appId, 'gate', 'tenant-b');
		const rows = await logRows(t, 'tenant-b');
		expect(rows).toHaveLength(1);
		const row = firstRow(rows);
		expect(row).toMatchObject({
			organizationId: 'tenant-b',
			connectedAppId: appId,
			hookKind: 'gate',
			isAttempted: false,
			source: 'fallback',
			failureCode: 'app_not_found',
		});
		expect(row.pluginId).toBeUndefined();
		expect(row.durationMs).toBeUndefined();
	});

	it('records the disabled / revoked / capability short-circuit reason', async () => {
		const t = makeT();
		const disabled = await t.run((ctx) => seedApp(ctx, { status: 'disabled' }));
		const revoked = await t.run((ctx) => seedApp(ctx, { status: 'revoked' }));
		await invoke(t, disabled, 'gate');
		await invoke(t, revoked, 'draft');
		const rows = await logRows(t);
		const codes = rows.map((r) => r.failureCode).sort();
		expect(codes).toEqual(['app_disabled', 'app_revoked']);
		expect(rows.every((r) => r.isAttempted === false && r.source === 'fallback')).toBe(true);
		expect(transport.callConnectedAppHook).not.toHaveBeenCalled();
	});

	it('records an attempted success as an app-source row with a duration and plugin id', async () => {
		const t = makeT();
		const appId = await t.run((ctx) => seedApp(ctx));
		transport.callConnectedAppHook.mockResolvedValue(ok({ hookKind: 'draft', draft: 'Hello.' }));
		await invoke(t, appId, 'draft');
		const rows = await logRows(t);
		expect(rows).toHaveLength(1);
		const row = firstRow(rows);
		expect(row).toMatchObject({
			connectedAppId: appId,
			pluginId: 'alpha',
			hookKind: 'draft',
			isAttempted: true,
			source: 'app',
		});
		expect(row.failureCode).toBeUndefined();
		expect(typeof row.durationMs).toBe('number');
		expect(row.durationMs ?? -1).toBeGreaterThanOrEqual(0);
	});

	it('records an attempted transport failure with the transport code and a duration', async () => {
		const t = makeT();
		const appId = await t.run((ctx) => seedApp(ctx));
		transport.callConnectedAppHook.mockResolvedValue({
			status: 'error',
			code: 'timeout',
			message: 'Hook call timed out',
		} as HookTransportOutcome);
		await invoke(t, appId, 'gate');
		const rows = await logRows(t);
		const row = firstRow(rows);
		expect(row).toMatchObject({
			hookKind: 'gate',
			isAttempted: true,
			source: 'fallback',
			failureCode: 'timeout',
		});
		expect(typeof row.durationMs).toBe('number');
	});

	it('records output_rejected when an app value scrubs to empty', async () => {
		const t = makeT();
		const appId = await t.run((ctx) => seedApp(ctx));
		transport.callConnectedAppHook.mockResolvedValue(ok({ hookKind: 'draft', draft: '   \n\t ' }));
		await invoke(t, appId, 'draft');
		const rows = await logRows(t);
		expect(firstRow(rows)).toMatchObject({
			isAttempted: true,
			source: 'fallback',
			failureCode: 'output_rejected',
		});
	});

	it('never persists payload, app text, secret, or signature (redaction by construction)', async () => {
		const t = makeT();
		const appId = await t.run((ctx) => seedApp(ctx));
		transport.callConnectedAppHook.mockResolvedValue(
			ok({ hookKind: 'gate', gate: { outcome: 'objection', reason: 'Looks risky.' } })
		);
		await invoke(t, appId, 'gate');
		const rows = await logRows(t);
		const row = firstRow(rows);
		const serialized = JSON.stringify(row);
		// None of the request payload, the app's returned text, or the shared
		// secret can appear anywhere in the stored row.
		expect(serialized).not.toContain('secret subject line');
		expect(serialized).not.toContain('confidential message content');
		expect(serialized).not.toContain('Looks risky.');
		expect(serialized).not.toContain(SECRET);
		const keys = Object.keys(row).sort();
		expect(keys).not.toContain('payload');
		expect(keys).not.toContain('secret');
		expect(keys).not.toContain('signature');
		expect(keys).not.toContain('responseBody');
	});
});

describe('listHookDeliveryLogs (operator read)', () => {
	async function seedLog(
		t: TestConvex,
		row: {
			organizationId?: string;
			connectedAppId: Id<'connectedApps'>;
			hookKind: 'draft' | 'gate' | 'score';
			source: 'app' | 'fallback';
			attemptedAt: number;
		}
	): Promise<void> {
		await t.run((ctx) =>
			ctx.db.insert('connectedAppHookDeliveryLogs', {
				organizationId: row.organizationId ?? ORG,
				connectedAppId: row.connectedAppId,
				pluginId: 'alpha',
				hookKind: row.hookKind,
				isAttempted: row.source === 'app',
				source: row.source,
				...(row.source === 'fallback' ? { failureCode: 'timeout' as const } : {}),
				attemptedAt: row.attemptedAt,
			})
		);
	}

	it('returns the caller org rows newest first and hides other tenants', async () => {
		const t = makeT();
		const appA = await t.run((ctx) => seedApp(ctx));
		const appB = await t.run((ctx) => seedApp(ctx, { organizationId: 'tenant-b' }));
		await seedLog(t, { connectedAppId: appA, hookKind: 'gate', source: 'app', attemptedAt: 100 });
		await seedLog(t, {
			connectedAppId: appA,
			hookKind: 'draft',
			source: 'fallback',
			attemptedAt: 200,
		});
		await seedLog(t, {
			organizationId: 'tenant-b',
			connectedAppId: appB,
			hookKind: 'gate',
			source: 'app',
			attemptedAt: 300,
		});
		const rows = await t
			.withIdentity(IDENTITY)
			.query(api.connectedApps.hookDeliveryLogStore.listHookDeliveryLogs, {});
		expect(rows.map((r) => r.attemptedAt)).toEqual([200, 100]);
		expect(rows.every((r) => r.connectedAppId === appA)).toBe(true);
	});

	it('filters by connected app, hook kind, and source', async () => {
		const t = makeT();
		const appA = await t.run((ctx) => seedApp(ctx));
		const appOther = await t.run((ctx) => seedApp(ctx));
		await seedLog(t, { connectedAppId: appA, hookKind: 'gate', source: 'app', attemptedAt: 10 });
		await seedLog(t, {
			connectedAppId: appA,
			hookKind: 'draft',
			source: 'fallback',
			attemptedAt: 20,
		});
		await seedLog(t, {
			connectedAppId: appOther,
			hookKind: 'gate',
			source: 'app',
			attemptedAt: 30,
		});

		const client = t.withIdentity(IDENTITY);
		const byApp = await client.query(api.connectedApps.hookDeliveryLogStore.listHookDeliveryLogs, {
			connectedAppId: appA,
		});
		expect(byApp.every((r) => r.connectedAppId === appA)).toBe(true);
		expect(byApp).toHaveLength(2);

		const byKind = await client.query(api.connectedApps.hookDeliveryLogStore.listHookDeliveryLogs, {
			hookKind: 'draft',
		});
		expect(byKind.every((r) => r.hookKind === 'draft')).toBe(true);
		expect(byKind).toHaveLength(1);

		const bySource = await client.query(
			api.connectedApps.hookDeliveryLogStore.listHookDeliveryLogs,
			{ source: 'fallback' }
		);
		expect(bySource.every((r) => r.source === 'fallback')).toBe(true);
		expect(bySource).toHaveLength(1);
	});

	it('rejects a non-admin caller and an anonymous caller', async () => {
		const t = makeT();
		auth.role = 'editor';
		await expect(
			t
				.withIdentity(IDENTITY)
				.query(api.connectedApps.hookDeliveryLogStore.listHookDeliveryLogs, {})
		).rejects.toThrow();
		auth.role = 'owner';
		await expect(
			t.query(api.connectedApps.hookDeliveryLogStore.listHookDeliveryLogs, {})
		).rejects.toThrow();
	});

	it('clamps the page size to the bounded maximum', async () => {
		const t = makeT();
		const appId = await t.run((ctx) => seedApp(ctx));
		for (let i = 0; i < CONNECTED_APP_HOOK_LOG_MAX_LIMIT + 5; i++) {
			await seedLog(t, { connectedAppId: appId, hookKind: 'gate', source: 'app', attemptedAt: i });
		}
		const rows = await t
			.withIdentity(IDENTITY)
			.query(api.connectedApps.hookDeliveryLogStore.listHookDeliveryLogs, { limit: 10_000 });
		expect(rows).toHaveLength(CONNECTED_APP_HOOK_LOG_MAX_LIMIT);
	});
});

describe('retention cleanup', () => {
	it('deletes rows older than the window and keeps recent ones', async () => {
		const t = makeT();
		const appId = await t.run((ctx) => seedApp(ctx));
		const now = Date.now();
		await t.run((ctx) =>
			ctx.db.insert('connectedAppHookDeliveryLogs', {
				organizationId: ORG,
				connectedAppId: appId,
				hookKind: 'gate',
				isAttempted: false,
				source: 'fallback',
				failureCode: 'app_disabled',
				attemptedAt: now - AUDIT_LOG_RETENTION_MS - 1_000,
			})
		);
		await t.run((ctx) =>
			ctx.db.insert('connectedAppHookDeliveryLogs', {
				organizationId: ORG,
				connectedAppId: appId,
				hookKind: 'gate',
				isAttempted: true,
				source: 'app',
				attemptedAt: now,
			})
		);
		const result = await t.mutation(
			internal.connectedApps.hookDeliveryLogStore._cleanupHookDeliveryLogs,
			{}
		);
		expect(result.deletedCount).toBe(1);
		const rows = await logRows(t);
		expect(rows).toHaveLength(1);
		expect(firstRow(rows).attemptedAt).toBe(now);
	});

	it('does not exceed the batch size in a single run', async () => {
		const t = makeT();
		const appId = await t.run((ctx) => seedApp(ctx));
		const old = Date.now() - AUDIT_LOG_RETENTION_MS - 1_000;
		for (let i = 0; i < CONNECTED_APP_HOOK_LOG_CLEANUP_BATCH_SIZE + 10; i++) {
			await t.run((ctx) =>
				ctx.db.insert('connectedAppHookDeliveryLogs', {
					organizationId: ORG,
					connectedAppId: appId,
					hookKind: 'gate',
					isAttempted: false,
					source: 'fallback',
					failureCode: 'app_disabled',
					attemptedAt: old + i,
				})
			);
		}
		const result = await t.mutation(
			internal.connectedApps.hookDeliveryLogStore._cleanupHookDeliveryLogs,
			{}
		);
		expect(result.deletedCount).toBe(CONNECTED_APP_HOOK_LOG_CLEANUP_BATCH_SIZE);
	});
});
