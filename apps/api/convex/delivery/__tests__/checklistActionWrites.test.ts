/**
 * What the Deliverability Center's verification and loopback actions write.
 *
 * The actions run against a real convex-test database: every mutation goes to
 * the real module, while the auth floor, the read-only context queries, the
 * live observation and the probe send are stubbed, so these tests pin the
 * stored outcome of each path rather than how many mutations produced it.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { deliverabilityTargetKey } from '../checklistEvidence';
import { modules } from './helpers/convexModules';

const observer = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('../checklistDeploymentValidators', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	observeDeploymentCheck: observer.observe,
}));

import { retry, sweep, verifyNow } from '../checklistVerification';
import { start } from '../checklistLoopback';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const ORG = 'org-checklist-writes';
// A deployment check whose interactive run triggers no MTA sync action.
const DEPLOYMENT_ITEM = 'deployment.relay' as const;
const DEPLOYMENT_TARGET = deliverabilityTargetKey(ORG);

type AnyRef = FunctionReference<'query' | 'mutation' | 'action', 'public' | 'internal'>;
type Stubs = Record<string, (args: Record<string, unknown>) => unknown>;

/**
 * An action ctx whose mutations hit the real database. Queries and actions
 * named in `stubs` answer from the stub; other queries are real.
 */
function bridgeCtx(t: TestConvex<typeof schema>, stubs: Stubs) {
	const stubbed = (ref: AnyRef, args: Record<string, unknown>) => {
		const stub = stubs[getFunctionName(ref)];
		return stub ? { hit: true as const, value: stub(args) } : { hit: false as const };
	};
	return {
		runQuery: async (ref: AnyRef, args: Record<string, unknown>) => {
			const answer = stubbed(ref, args);
			return answer.hit ? await answer.value : await t.query(ref as never, args as never);
		},
		runMutation: (ref: AnyRef, args: Record<string, unknown>) =>
			t.mutation(ref as never, args as never),
		runAction: async (ref: AnyRef, args: Record<string, unknown>) => {
			const answer = stubbed(ref, args);
			if (!answer.hit) throw new Error(`unexpected action ${getFunctionName(ref)}`);
			return await answer.value;
		},
	};
}

type Handler = (ctx: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
const handlerOf = (fn: unknown) => (fn as { _handler: Handler })._handler;

const adminStubs: Stubs = {
	'auth/membership:assertOrgMember': () => ({ organizationId: ORG }),
	'delivery/checklist:getAdminScope': () => ({ organizationId: ORG }),
	'delivery/checklist:getVerificationContext': () => ({}),
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	observer.observe.mockReset();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

const verificationState = (t: TestConvex<typeof schema>) =>
	t.run((ctx) =>
		ctx.db
			.query('deliverabilityVerificationState')
			.withIndex('by_org_target_item', (q) =>
				q.eq('organizationId', ORG).eq('targetKey', DEPLOYMENT_TARGET).eq('itemId', DEPLOYMENT_ITEM)
			)
			.unique()
	);

const evidenceRows = (t: TestConvex<typeof schema>) =>
	t.run((ctx) => ctx.db.query('deliverabilityEvidence').collect());

const scheduledNames = (t: TestConvex<typeof schema>) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
	);

describe('checklist verification writes', () => {
	it('records the observation as evidence and releases the lease', async () => {
		const t = convexTest(schema, modules);
		observer.observe.mockResolvedValue({
			validator: 'deployment.test',
			status: 'pass',
			observedValues: ['observed=1'],
			diagnostic: 'All good.',
		});

		const result = await handlerOf(sweep)(bridgeCtx(t, adminStubs), {
			organizationId: ORG,
			itemId: DEPLOYMENT_ITEM,
		});

		expect(result).toEqual({ accepted: true, status: 'pass' });
		const [evidence, ...others] = await evidenceRows(t);
		expect(others).toEqual([]);
		expect(evidence).toMatchObject({
			organizationId: ORG,
			itemId: DEPLOYMENT_ITEM,
			validator: 'deployment.test',
			status: 'pass',
			observedValues: ['observed=1'],
			diagnostic: 'All good.',
			observedAt: NOW,
		});
		const state = await verificationState(t);
		expect(state).toMatchObject({
			generation: 1,
			retryIndex: 0,
			leaseExpiresAt: NOW,
			currentEvidenceId: evidence!._id,
		});
		expect(state?.nextCheckAt).toBeUndefined();
		expect(await scheduledNames(t)).not.toContain('delivery/checklistVerification:retry');
	});

	it('records an orchestrator warning and schedules a retry when the observation throws', async () => {
		const t = convexTest(schema, modules);
		observer.observe.mockRejectedValue(new Error('resolver exploded'));

		const result = await handlerOf(verifyNow)(bridgeCtx(t, adminStubs), {
			itemId: DEPLOYMENT_ITEM,
		});

		expect(result).toEqual({ accepted: true, status: 'warn' });
		const [evidence] = await evidenceRows(t);
		expect(evidence).toMatchObject({
			validator: 'checklist.orchestrator',
			status: 'warn',
			observedValues: [],
		});
		expect(evidence?.diagnostic).toContain('temporarily unconfirmed');
		const state = await verificationState(t);
		expect(state?.retryIndex).toBe(1);
		expect(state?.nextCheckAt).toBeGreaterThan(NOW);
		expect(await scheduledNames(t)).toContain('delivery/checklistVerification:retry');
	});

	it('writes nothing while another verifier holds the lease', async () => {
		const t = convexTest(schema, modules);
		observer.observe.mockResolvedValue({
			validator: 'deployment.test',
			status: 'pass',
			observedValues: [],
			diagnostic: 'ok',
		});
		await t.run((ctx) =>
			ctx.db.insert('deliverabilityVerificationState', {
				organizationId: ORG,
				itemId: DEPLOYMENT_ITEM,
				targetKey: DEPLOYMENT_TARGET,
				attemptId: 'other-attempt',
				generation: 3,
				retryIndex: 0,
				leaseToken: 'other-lease',
				leaseExpiresAt: NOW + 60_000,
				updatedAt: NOW,
			})
		);

		const result = await handlerOf(verifyNow)(bridgeCtx(t, adminStubs), {
			itemId: DEPLOYMENT_ITEM,
		});

		expect(result).toEqual({ accepted: false });
		expect(observer.observe).not.toHaveBeenCalled();
		expect(await evidenceRows(t)).toEqual([]);
		expect((await verificationState(t))?.attemptId).toBe('other-attempt');
	});

	it('runs a due retry under the generation it was scheduled for', async () => {
		const t = convexTest(schema, modules);
		observer.observe.mockResolvedValue({
			validator: 'deployment.test',
			status: 'fail',
			observedValues: [],
			diagnostic: 'Still broken.',
		});
		await t.run((ctx) =>
			ctx.db.insert('deliverabilityVerificationState', {
				organizationId: ORG,
				itemId: DEPLOYMENT_ITEM,
				targetKey: DEPLOYMENT_TARGET,
				attemptId: 'earlier-attempt',
				generation: 2,
				retryIndex: 1,
				nextCheckAt: NOW - 1,
				leaseToken: 'earlier-lease',
				leaseExpiresAt: NOW - 1,
				updatedAt: NOW - 1,
			})
		);

		const result = await handlerOf(retry)(bridgeCtx(t, adminStubs), {
			organizationId: ORG,
			itemId: DEPLOYMENT_ITEM,
			expectedGeneration: 2,
		});

		expect(result).toEqual({ accepted: true, status: 'fail' });
		const [evidence] = await evidenceRows(t);
		expect(evidence).toMatchObject({ status: 'fail', diagnostic: 'Still broken.' });
		expect(await verificationState(t)).toMatchObject({
			generation: 2,
			currentEvidenceId: evidence!._id,
			leaseExpiresAt: NOW,
		});
	});
});

describe('loopback probe start writes', () => {
	const sendProbe = vi.fn();

	beforeEach(() => {
		sendProbe.mockReset();
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'bounce.owlat.example');
		vi.stubEnv('MTA_WEBHOOK_SECRET', 'loopback-test-secret');
	});

	async function seedDomain(t: TestConvex<typeof schema>): Promise<Id<'domains'>> {
		return await t.run((ctx) =>
			ctx.db.insert('domains', {
				domain: 'probe.example',
				status: 'verified',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: NOW,
				updatedAt: NOW,
			} as never)
		);
	}

	const loopbackStubs: Stubs = {
		...adminStubs,
		'delivery/checklistLoopbackState:getStartContext': () => ({
			allowed: true,
			domain: 'probe.example',
		}),
		'systemMail:sendSystemEmail': (args) => sendProbe(args),
	};

	const attempts = (t: TestConvex<typeof schema>) =>
		t.run((ctx) => ctx.db.query('deliverabilityLoopbackAttempts').collect());

	it('stores an accepted probe as awaiting inbound, with its expiry scheduled', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		sendProbe.mockResolvedValue({ providerMessageId: 'probe-message-1' });

		const result = await handlerOf(start)(bridgeCtx(t, loopbackStubs), { domainId });

		expect(result).toEqual({ status: 'awaiting_inbound' });
		const [attempt, ...others] = await attempts(t);
		expect(others).toEqual([]);
		expect(attempt).toMatchObject({
			organizationId: ORG,
			domainId,
			domain: 'probe.example',
			status: 'awaiting_inbound',
			providerMessageId: 'probe-message-1',
			startedAt: NOW,
			expiresAt: NOW + 15 * 60_000,
		});
		expect(sendProbe).toHaveBeenCalledTimes(1);
		expect(String(sendProbe.mock.calls[0]![0].to)).toMatch(
			/^deliverability-probe\+.+@bounce\.owlat\.example$/
		);
		expect(await scheduledNames(t)).toEqual(['delivery/checklistLoopbackState:expire']);
	});

	it('stores a probe the provider refused as failed', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		sendProbe.mockRejectedValue(new Error('provider refused'));

		const result = await handlerOf(start)(bridgeCtx(t, loopbackStubs), { domainId });

		expect(result).toEqual({ status: 'failed' });
		const [attempt] = await attempts(t);
		expect(attempt).toMatchObject({
			status: 'failed',
			detail: 'The configured outbound provider did not accept the probe.',
			completedAt: NOW,
		});
		expect(attempt?.providerMessageId).toBeUndefined();
	});

	it('reports the probe already in flight without sending a second one', async () => {
		const t = convexTest(schema, modules);
		const domainId = await seedDomain(t);
		sendProbe.mockResolvedValue({ providerMessageId: 'probe-message-1' });
		await handlerOf(start)(bridgeCtx(t, loopbackStubs), { domainId });

		const again = await handlerOf(start)(bridgeCtx(t, loopbackStubs), { domainId });

		expect(again).toEqual({ status: 'awaiting_inbound' });
		expect(sendProbe).toHaveBeenCalledTimes(1);
		expect(await attempts(t)).toHaveLength(1);
	});
});
