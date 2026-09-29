/**
 * The facet and growth counters (plan 3.1) against a full scan.
 *
 * Property: after any sequence of the writes that create, delete or move a
 * campaign's status, a template's type, an automation's status or a contact's
 * liveness — through the real mutations and lifecycles — every bucket equals
 * what a scan of the table says. That holds before the scope exists, while its
 * backfill walk is part-way (the rows at or before the watermark), and once it
 * is ready. The readers (`countFacet`, the growth series) then answer from the
 * buckets with the same numbers the scans gave.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import rateLimiterTest from '@convex-dev/rate-limiter/test';
import schema from '../schema';
import type { Doc, Id } from '../_generated/dataModel';
import { api, internal } from '../_generated/api';
import { createTestAutomationStep, enableFeatures } from './factories';
import {
	counterScopeKey,
	creationPosition,
	isCountedPosition,
	loadCounterScope,
	startCounterScope,
	type CounterKind,
} from '../lib/counters';
import { listingCounterBuckets } from '../lib/listingCounters';
import { contactGrowthBuckets, readContactGrowth } from '../contacts/growthCounters';
import { runCounterBackfillStep } from '../maintenance/counterBackfill';
import { countFacet, type GroupedCount } from '../lib/listing';
import { campaignListing } from '../campaigns/listing';
import { emailTemplateListing } from '../emailTemplates/listing';
import { automationListing } from '../automations/listing';
import { resolveContact } from '../contacts/resolution';
import { permanentlyDeleteContactWithRelations, softDeleteContact } from '../lib/contactMutations';
import { utcDayKey } from '../lib/clock';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const session = { userId: 'user-alice', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn(async () => session.userId),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
		requireOrgPermission: vi.fn(async () => session),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/index') &&
			!path.includes('agent/steps/shared') &&
			!path.includes('agent/steps/classify') &&
			!path.includes('agent/steps/draft') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

type Test = TestConvex<typeof schema>;
const DAY = 24 * 60 * 60 * 1000;
const SYSTEM = 'system:test';

function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		int: (n: number) => Math.floor(next() * n),
		pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
		chance: (p: number) => next() < p,
	};
}
type Rng = ReturnType<typeof rng>;

const SCOPES: ReadonlyArray<{
	kind: CounterKind;
	table: 'campaigns' | 'emailTemplates' | 'automations' | 'contacts';
	buckets: (row: never) => readonly string[];
}> = [
	{
		kind: 'campaignStatus',
		table: 'campaigns',
		buckets: (row: Doc<'campaigns'>) => listingCounterBuckets('campaignStatus', row),
	},
	{
		kind: 'templateType',
		table: 'emailTemplates',
		buckets: (row: Doc<'emailTemplates'>) => listingCounterBuckets('templateType', row),
	},
	{
		kind: 'automationStatus',
		table: 'automations',
		buckets: (row: Doc<'automations'>) => listingCounterBuckets('automationStatus', row),
	},
	{ kind: 'contactCreatedDay', table: 'contacts', buckets: contactGrowthBuckets },
] as never;

async function ids<T extends 'campaigns' | 'emailTemplates' | 'automations' | 'contacts'>(
	t: Test,
	table: T
): Promise<Id<T>[]> {
	return t.run(async (ctx) => (await ctx.db.query(table).collect()).map((row) => row._id as Id<T>));
}

async function swallow(run: () => Promise<unknown>): Promise<void> {
	try {
		await run();
	} catch {
		// A refused write (deleting a sending campaign, an illegal edge) is part
		// of the sequence: it must leave the counters untouched.
	}
}

async function randomOp(t: Test, r: Rng): Promise<void> {
	// Move the clock, so contacts land on different UTC days.
	vi.setSystemTime(Date.now() + r.int(DAY / 2));
	const roll = r.int(14);
	const campaigns = await ids(t, 'campaigns');
	const templates = await ids(t, 'emailTemplates');
	const automations = await ids(t, 'automations');
	const contacts = await ids(t, 'contacts');
	const at = Date.now();

	if (roll === 0 || (roll <= 3 && campaigns.length === 0)) {
		await t.mutation(api.campaigns.campaigns.create, { name: `c${r.int(1000)}` });
	} else if (roll === 1) {
		await t.mutation(api.campaigns.campaigns.duplicate, { campaignId: r.pick(campaigns) });
	} else if (roll === 2) {
		await swallow(() =>
			t.mutation(api.campaigns.campaigns.remove, { campaignId: r.pick(campaigns) })
		);
	} else if (roll === 3) {
		const to = r.pick([
			'draft',
			'cancelled',
			'sending',
			'sent',
			'pending_review',
			'scheduled',
		] as const);
		await t.mutation(internal.campaigns.lifecycle.transition, {
			campaignId: r.pick(campaigns),
			input: to === 'scheduled' ? { to, at, scheduledAt: at + DAY } : { to, at },
			userId: SYSTEM,
		});
	} else if (roll === 4 || (roll <= 6 && templates.length === 0)) {
		await t.mutation(internal.emailTemplates.lifecycle.create, {
			name: `t${r.int(1000)}`,
			type: r.pick(['marketing', 'transactional'] as const),
			userId: SYSTEM,
		});
	} else if (roll === 5) {
		await t.mutation(
			r.chance(0.5)
				? internal.emailTemplates.lifecycle.duplicate
				: internal.emailTemplates.lifecycle.remove,
			{ templateId: r.pick(templates), userId: SYSTEM }
		);
	} else if (roll === 6) {
		await t.mutation(api.emailTemplates.emails.changeType, {
			templateId: r.pick(templates),
			type: r.pick(['marketing', 'transactional'] as const),
		});
	} else if (roll === 7 || (roll <= 9 && automations.length === 0)) {
		const id = await t.mutation(api.automations.automations.create, {
			name: `a${r.int(1000)}`,
			triggerType: 'contact_created',
		});
		// Half of them can be activated (activation needs a step).
		if (r.chance(0.5)) {
			await t.run(async (ctx) => {
				await ctx.db.insert(
					'automationSteps',
					createTestAutomationStep({ automationId: id, stepType: 'delay', stepIndex: 0 }) as never
				);
			});
		}
	} else if (roll === 8) {
		const automationId = r.pick(automations);
		if (r.chance(0.5)) await t.mutation(api.automations.automations.duplicate, { automationId });
		else await swallow(() => t.mutation(api.automations.automations.remove, { automationId }));
	} else if (roll === 9) {
		await t.mutation(internal.automations.lifecycle.transition, {
			automationId: r.pick(automations),
			input: { to: r.pick(['active', 'paused', 'draft'] as const), at },
			userId: SYSTEM,
		});
	} else if (roll <= 11 || contacts.length === 0) {
		await t.run(async (ctx) => {
			await resolveContact(ctx, {
				channel: 'email',
				identifier: `p${r.int(1e6)}@example.com`,
				source: 'api',
				mode: 'upsert',
			});
		});
	} else if (roll === 12) {
		await t.run(async (ctx) => softDeleteContact(ctx, r.pick(contacts), 'test'));
	} else {
		await t.run(async (ctx) =>
			permanentlyDeleteContactWithRelations(ctx, r.pick(contacts), { decrementCount: false })
		);
	}
}

async function expectCountersMatchScan(t: Test, label: string): Promise<void> {
	const { stored, expected } = await t.run(async (ctx) => {
		const stored: Record<string, Record<string, number>> = {};
		const expected: Record<string, Record<string, number>> = {};
		for (const { kind, table, buckets } of SCOPES) {
			const scope = counterScopeKey(kind);
			const state = await loadCounterScope(ctx.db, scope);
			const rows = (await ctx.db.query(table).collect()) as never[];
			const counted = !state
				? []
				: state.isReady
					? rows
					: rows.filter((row: { _creationTime: number }) =>
							isCountedPosition(creationPosition(row), state.watermark)
						);
			const tally: Record<string, number> = {};
			for (const row of counted) for (const b of buckets(row)) tally[b] = (tally[b] ?? 0) + 1;
			expected[scope] = tally;
			const bucketRows = await ctx.db
				.query('counterBuckets')
				.withIndex('by_scope_and_bucket', (q) => q.eq('scope', scope))
				.collect();
			stored[scope] = Object.fromEntries(bucketRows.map((b) => [b.bucket, b.count]));
		}
		return { stored, expected };
	});
	expect(stored, label).toEqual(expected);
}

async function allReady(t: Test): Promise<boolean> {
	return t.run(async (ctx) => {
		for (const { kind } of SCOPES) {
			if (!(await loadCounterScope(ctx.db, counterScopeKey(kind)))?.isReady) return false;
		}
		return true;
	});
}

async function freshT(): Promise<Test> {
	const t = convexTest(schema, modules);
	rateLimiterTest.register(t);
	await enableFeatures(t, ['campaigns', 'automations']);
	return t;
}

describe('facet and growth counters equal a full scan (plan 3.1)', () => {
	beforeEach(() => {
		// Scheduled hops (a campaign's send orchestrator) must not fire mid-test.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
		vi.setSystemTime(Date.UTC(2026, 8, 1, 9));
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	for (const seed of [3, 17, 256, 1024, 4096]) {
		it(`stays exact through random writes and a racing backfill (seed ${seed})`, async () => {
			const r = rng(seed);
			const t = await freshT();
			for (let i = 0; i < 30; i++) await randomOp(t, r);
			await expectCountersMatchScan(t, 'before any scope exists');

			await t.run(async (ctx) => {
				for (const { kind } of SCOPES) await startCounterScope(ctx, kind, undefined);
			});
			let step = 0;
			while (!(await allReady(t))) {
				step += 1;
				for (let i = 0; i < 2; i++) {
					await randomOp(t, r);
					await expectCountersMatchScan(t, `walk step ${step} (write ${i})`);
				}
				for (const { kind } of SCOPES) {
					await t.run((ctx) => runCounterBackfillStep(ctx, counterScopeKey(kind), 2));
				}
				await expectCountersMatchScan(t, `walk step ${step} (page)`);
				expect(step).toBeLessThan(500);
			}

			for (let i = 0; i < 40; i++) {
				await randomOp(t, r);
				await expectCountersMatchScan(t, `after ready, op ${i}`);
			}

			// The readers answer from the buckets with the scans' numbers.
			const uncounted = <T extends { facets?: Record<string, unknown> }>(d: T, facet: string): T =>
				({
					...d,
					facets: { [facet]: { ...(d.facets![facet] as object), counter: undefined } },
				}) as T;
			await t.run(async (ctx) => {
				for (const [descriptor, facet] of [
					[campaignListing, 'byStatus'],
					[emailTemplateListing, 'byType'],
					[automationListing, 'byStatus'],
				] as const) {
					const counted = (await countFacet(ctx.db, descriptor as never, facet)) as GroupedCount;
					const scanned = (await countFacet(
						ctx.db,
						uncounted(descriptor, facet) as never,
						facet
					)) as GroupedCount;
					expect(counted, facet).toEqual(scanned);
				}
				const now = Date.now();
				const first = utcDayKey(now - 29 * DAY);
				const last = utcDayKey(now);
				const growth = await readContactGrowth(ctx.db, first, last);
				const live = (await ctx.db.query('contacts').collect()).filter(
					(c) => c.deletedAt === undefined
				);
				const scan = new Map<string, number>();
				for (const c of live) {
					const day = utcDayKey(c.createdAt);
					if (day >= first && day <= last) scan.set(day, (scan.get(day) ?? 0) + 1);
				}
				expect(growth).toEqual(scan);
			});
		});
	}
});
