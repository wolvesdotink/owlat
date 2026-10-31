/**
 * What one alignment pre-flight sweep run writes: a verdict row per due
 * verified domain, and a continuation only when the walk did not finish.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ALIGNMENT_SWEEP_MAX_PAGES,
	ALIGNMENT_SWEEP_PAGE_SIZE,
} from '@owlat/shared/deliverabilityAlignment';
import schema from '../../schema';
import betterAuthSchema from '../../betterAuth/schema';
import { components, internal } from '../../_generated/api';
import { _resetSingletonOrgCacheForTests } from '../../lib/sessionOrganization';
import { modules } from './helpers/convexModules';

const dns = vi.hoisted(() => ({ records: new Map<string, string[][]>() }));
vi.mock('node:dns/promises', () => ({
	Resolver: class {
		async resolveTxt(name: string): Promise<string[][]> {
			const records = dns.records.get(name);
			if (records) return records;
			throw Object.assign(new Error(`no record for ${name}`), { code: 'ENOTFOUND' });
		}
	},
}));

const betterAuthModules = import.meta.glob('../../betterAuth/**/*.*s');
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const SWEEP = 'delivery/alignmentPreflightGather:runAlignmentPreflightSweep';

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	// One relay with no signing identity: the reference arm is `unknown`, so
	// every domain with an own-MTA identity is a target.
	vi.stubEnv('EMAIL_PROVIDER', 'ses');
	vi.stubEnv('MTA_IP_POOLS', '203.0.113.10');
	dns.records.clear();
	_resetSingletonOrgCacheForTests();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

async function harness(): Promise<TestConvex<typeof schema>> {
	const t = convexTest(schema, modules);
	t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules);
	await t.mutation(components.betterAuth.adapter.create, {
		input: { model: 'organization', data: { name: 'Owlat', slug: 'owlat', createdAt: NOW } },
	} as never);
	return t;
}

async function seedDomains(t: TestConvex<typeof schema>, count: number): Promise<string[]> {
	return await t.run(async (ctx) => {
		const names: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const domain = `d${String(index).padStart(2, '0')}.example.com`;
			const domainId = await ctx.db.insert('domains', {
				domain,
				status: 'verified',
				dnsRecords: {},
				providerType: 'mta',
				createdAt: NOW,
				updatedAt: NOW,
			} as never);
			await ctx.db.insert('sendingDomainMtaIdentities', {
				domainId,
				dkimSelector: 's1',
				createdAt: NOW,
				updatedAt: NOW,
			});
			names.push(domain);
		}
		return names;
	});
}

const alignmentRows = (t: TestConvex<typeof schema>) =>
	t.run((ctx) => ctx.db.query('deliverabilityAlignmentStates').collect());

const scheduledSweeps = (t: TestConvex<typeof schema>) =>
	t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).filter(
			(job) => job.name === SWEEP
		)
	);

describe('runAlignmentPreflightSweep writes', () => {
	it('records one verdict per due domain and schedules nothing once the walk is done', async () => {
		const t = await harness();
		const [domain] = await seedDomains(t, 2);
		dns.records.set(domain!, [['v=spf1 ip4:203.0.113.10 -all']]);

		const result = await t.action(
			internal.delivery.alignmentPreflightGather.runAlignmentPreflightSweep,
			{}
		);

		expect(result).toEqual({ checked: 2, done: true });
		const rows = await alignmentRows(t);
		expect(rows.map((row) => row.domain).sort()).toEqual(['d00.example.com', 'd01.example.com']);
		for (const row of rows) {
			expect(row.checkedAt).toBe(NOW);
			expect(row.updatedAt).toBe(NOW);
			expect(row.nextCheckDueAt).toBeGreaterThan(NOW);
			expect(row.checks.length).toBeGreaterThan(0);
		}
		expect(await scheduledSweeps(t)).toEqual([]);
	});

	it('skips a domain whose verdict is not due yet', async () => {
		const t = await harness();
		await seedDomains(t, 1);
		await t.action(internal.delivery.alignmentPreflightGather.runAlignmentPreflightSweep, {});
		const [first] = await alignmentRows(t);

		vi.setSystemTime(NOW + 60_000);
		const again = await t.action(
			internal.delivery.alignmentPreflightGather.runAlignmentPreflightSweep,
			{}
		);

		expect(again).toEqual({ checked: 0, done: true });
		expect(await alignmentRows(t)).toEqual([first]);
	});

	it('continues from its cursor when more domains remain than one run walks', async () => {
		const perRun = ALIGNMENT_SWEEP_MAX_PAGES * ALIGNMENT_SWEEP_PAGE_SIZE;
		const t = await harness();
		await seedDomains(t, perRun + 1);

		const result = await t.action(
			internal.delivery.alignmentPreflightGather.runAlignmentPreflightSweep,
			{}
		);

		expect(result).toEqual({ checked: perRun, done: false });
		expect(await alignmentRows(t)).toHaveLength(perRun);
		const [continuation, ...others] = await scheduledSweeps(t);
		expect(others).toEqual([]);
		if (!continuation) throw new Error('no continuation was scheduled');
		expect(continuation.scheduledTime).toBe(NOW + 500);
		const cursor = (continuation.args[0] as { cursor: string | null }).cursor;
		expect(typeof cursor).toBe('string');

		await t.action(internal.delivery.alignmentPreflightGather.runAlignmentPreflightSweep, {
			cursor,
		});
		expect(await alignmentRows(t)).toHaveLength(perRun + 1);
	});

	it('writes no verdict for a domain that stopped being verified during its lookups', async () => {
		const t = await harness();
		await seedDomains(t, 1);
		await t.run(async (ctx) => {
			const domain = await ctx.db.query('domains').first();
			await ctx.db.patch(domain!._id, { status: 'failed' });
		});

		const committed = await t.mutation(internal.delivery.alignmentPreflight.commitAlignmentSweep, {
			results: [
				{
					domain: 'd00.example.com',
					verdict: 'blocked',
					checks: [],
					isMeasurementDegraded: false,
					checkedAt: NOW,
					nextCheckDueAt: NOW + 60_000,
				},
			],
			cursor: null,
			isDone: true,
		});

		expect(committed).toEqual({ checked: 0 });
		expect(await alignmentRows(t)).toEqual([]);
	});
});
