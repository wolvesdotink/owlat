/**
 * Persistence surface for signed synchronous hooks, driven through the REAL
 * Convex internal query/mutation with convex-test. Proves the tenant-scoped
 * resolution and the per-(app,kind) circuit persistence that the Node runtime
 * relies on: a foreign-tenant id resolves to `{ found: false }` (no existence
 * leak, no secret), a run of failures trips the breaker OPEN with a persisted
 * open-until, a success closes it and clears the open-until, and the three hook
 * kinds keep independent breaker rows.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	CONNECTED_APP_HOOK_CIRCUIT_COOLDOWN_MS,
	CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD,
} from '../../lib/constants';

const rootGlob = import.meta.glob('../../**/*.*s');
const localGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../connectedApps/'),
		mod,
	])
);
const modules = { ...rootGlob, ...localGlob };

type Ctx = Parameters<Parameters<ReturnType<typeof convexTest>['run']>[0]>[0];

async function seedApp(
	ctx: Ctx,
	opts: { organizationId: string; status?: 'enabled' | 'disabled' | 'revoked' }
): Promise<Id<'connectedApps'>> {
	const now = Date.now();
	return ctx.db.insert('connectedApps', {
		organizationId: opts.organizationId,
		pluginId: 'alpha',
		name: 'alpha app',
		endpointUrl: 'https://hooks.example.com/x',
		status: opts.status ?? 'enabled',
		grantedCapabilities: ['send:gate'],
		secretCiphertext: 'cipher',
		secretIv: 'iv',
		secretAuthTag: 'tag',
		secretEnvelopeVersion: 1,
		secretRotatedAt: now,
		createdByUserId: 'seed',
		createdAt: now,
		updatedAt: now,
	});
}

async function loadHook(
	t: ReturnType<typeof convexTest>,
	organizationId: string,
	appId: Id<'connectedApps'>
) {
	return t.query(internal.connectedApps.hookStore._loadForHook, {
		organizationId,
		connectedAppId: appId,
		hookKind: 'gate',
	});
}

async function recordFailure(
	t: ReturnType<typeof convexTest>,
	organizationId: string,
	appId: Id<'connectedApps'>,
	nowMs: number,
	hookKind: 'draft' | 'gate' | 'score' = 'gate'
) {
	await t.mutation(internal.connectedApps.hookStore._recordHookOutcome, {
		organizationId,
		connectedAppId: appId,
		hookKind,
		outcome: 'failure',
		nowMs,
	});
}

describe('_loadForHook', () => {
	it('resolves a tenant-scoped app with its sealed secret and a neutral initial circuit', async () => {
		const t = convexTest(schema, modules);
		const appId = await t.run((ctx) => seedApp(ctx, { organizationId: 'tenant-a' }));
		const result = await loadHook(t, 'tenant-a', appId);
		if (!result.found) throw new Error('expected the app to resolve');
		expect(result.status).toBe('enabled');
		expect(result.pluginId).toBe('alpha');
		expect(result.endpointUrl).toBe('https://hooks.example.com/x');
		// No operator grant seeded → the restrict-only ceiling defaults CLOSED.
		expect(result.capabilityGranted).toBe(false);
		expect(result.secret).toEqual({
			secretCiphertext: 'cipher',
			secretIv: 'iv',
			secretAuthTag: 'tag',
			secretEnvelopeVersion: 1,
		});
		expect(result.circuit).toEqual({ consecutiveFailures: 0 });
	});

	it('returns { found: false } for a foreign-tenant id — no existence leak, no secret', async () => {
		const t = convexTest(schema, modules);
		const appId = await t.run((ctx) => seedApp(ctx, { organizationId: 'tenant-a' }));
		const result = await loadHook(t, 'tenant-b', appId);
		expect(result.found).toBe(false);
		// The false branch carries ONLY the neutral circuit — no status/secret/endpoint.
		expect(result).toEqual({ found: false, circuit: { consecutiveFailures: 0 } });
	});
});

describe('_recordHookOutcome — circuit persistence', () => {
	it('trips OPEN after the failure threshold and persists the open-until', async () => {
		const t = convexTest(schema, modules);
		const appId = await t.run((ctx) => seedApp(ctx, { organizationId: 'tenant-a' }));
		const now = 5_000_000;

		// One below the threshold: still closed.
		for (let i = 0; i < CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD - 1; i++) {
			await recordFailure(t, 'tenant-a', appId, now);
		}
		let loaded = await loadHook(t, 'tenant-a', appId);
		expect(loaded.circuit.consecutiveFailures).toBe(
			CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD - 1
		);
		expect(loaded.circuit.openedUntil).toBeUndefined();

		// The threshold-th failure opens it.
		await recordFailure(t, 'tenant-a', appId, now);
		loaded = await loadHook(t, 'tenant-a', appId);
		expect(loaded.circuit.consecutiveFailures).toBe(CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD);
		expect(loaded.circuit.openedUntil).toBe(now + CONNECTED_APP_HOOK_CIRCUIT_COOLDOWN_MS);
	});

	it('a success closes the breaker and clears the persisted open-until', async () => {
		const t = convexTest(schema, modules);
		const appId = await t.run((ctx) => seedApp(ctx, { organizationId: 'tenant-a' }));
		const now = 6_000_000;
		for (let i = 0; i < CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD; i++) {
			await recordFailure(t, 'tenant-a', appId, now);
		}
		expect((await loadHook(t, 'tenant-a', appId)).circuit.openedUntil).toBeDefined();

		await t.mutation(internal.connectedApps.hookStore._recordHookOutcome, {
			organizationId: 'tenant-a',
			connectedAppId: appId,
			hookKind: 'gate',
			outcome: 'success',
			nowMs: now + 1,
		});
		const loaded = await loadHook(t, 'tenant-a', appId);
		expect(loaded.circuit.consecutiveFailures).toBe(0);
		expect(loaded.circuit.openedUntil).toBeUndefined();
	});

	it('keeps independent breaker rows per hook kind', async () => {
		const t = convexTest(schema, modules);
		const appId = await t.run((ctx) => seedApp(ctx, { organizationId: 'tenant-a' }));
		const now = 7_000_000;
		// Fail 'gate' to the threshold; 'draft' is untouched.
		for (let i = 0; i < CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD; i++) {
			await recordFailure(t, 'tenant-a', appId, now, 'gate');
		}
		const gate = await t.query(internal.connectedApps.hookStore._loadForHook, {
			organizationId: 'tenant-a',
			connectedAppId: appId,
			hookKind: 'gate',
		});
		const draft = await t.query(internal.connectedApps.hookStore._loadForHook, {
			organizationId: 'tenant-a',
			connectedAppId: appId,
			hookKind: 'draft',
		});
		expect(gate.circuit.openedUntil).toBe(now + CONNECTED_APP_HOOK_CIRCUIT_COOLDOWN_MS);
		expect(draft.circuit).toEqual({ consecutiveFailures: 0 });
	});

	it("scopes breaker rows per tenant — one org cannot see another org's failures", async () => {
		const t = convexTest(schema, modules);
		const appA = await t.run((ctx) => seedApp(ctx, { organizationId: 'tenant-a' }));
		const now = 8_000_000;
		for (let i = 0; i < CONNECTED_APP_HOOK_CIRCUIT_FAILURE_THRESHOLD; i++) {
			await recordFailure(t, 'tenant-a', appA, now);
		}
		// A different tenant recording against the SAME app id keeps its own row.
		await recordFailure(t, 'tenant-b', appA, now);
		const rows = await t.run((ctx) =>
			ctx.db
				.query('connectedAppHookCircuits')
				.withIndex('by_app_and_kind', (index) =>
					index.eq('organizationId', 'tenant-b').eq('connectedAppId', appA).eq('hookKind', 'gate')
				)
				.unique()
		);
		expect(rows?.consecutiveFailures).toBe(1);
		expect(rows?.openedUntil).toBeUndefined();
	});
});
