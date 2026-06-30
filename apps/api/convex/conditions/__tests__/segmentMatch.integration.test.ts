import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import type { MutationCtx } from '../../_generated/server';
import {
	parseSegmentFilters,
	makeSegmentPredicate,
	matchLiveContacts,
	countLiveMatches,
	countLiveMatchesForSegments,
	evaluateAgainstContact,
	preloadConditionsLookup,
	countMatchingContactsPage,
	listMatchingContactsPage,
} from '../index';
import { recordContactActivity } from '../../contactActivities/writer';

const modules = import.meta.glob('../../**/*.*s');

/** Insert a minimal live contact and return the loaded Doc. */
async function insertContact(
	ctx: MutationCtx,
	overrides: Record<string, unknown> = {},
) {
	const id = await ctx.db.insert('contacts', {
		email: 'a@example.com',
		source: 'api',
		doiStatus: 'not_required',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	});
	return (await ctx.db.get(id))!;
}

describe('makeSegmentPredicate (pure matcher)', () => {
	it('AND requires every condition to match', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const contact = await insertContact(ctx, { email: 'alice@acme.com', source: 'api' });

			const filters = parseSegmentFilters({
				logic: 'AND',
				conditions: [
					{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' },
					{ kind: 'contact_property', field: 'source', operator: 'equals', value: 'api' },
				],
			});
			const lookup = await preloadConditionsLookup(ctx, filters.conditions);
			const matches = makeSegmentPredicate(filters, lookup);

			expect(matches(contact)).toBe(true);

			const wrongSource = await insertContact(ctx, { email: 'bob@acme.com', source: 'import' });
			expect(matches(wrongSource)).toBe(false);
		});
	});

	it('OR matches when any condition matches', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const contact = await insertContact(ctx, { email: 'alice@other.com', source: 'api' });

			const filters = parseSegmentFilters({
				logic: 'OR',
				conditions: [
					{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' },
					{ kind: 'contact_property', field: 'source', operator: 'equals', value: 'api' },
				],
			});
			const lookup = await preloadConditionsLookup(ctx, filters.conditions);
			const matches = makeSegmentPredicate(filters, lookup);

			expect(matches(contact)).toBe(true);
		});
	});

	it('empty conditions match every contact', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const contact = await insertContact(ctx);
			const filters = parseSegmentFilters({ logic: 'AND', conditions: [] });
			const lookup = await preloadConditionsLookup(ctx, filters.conditions);
			expect(makeSegmentPredicate(filters, lookup)(contact)).toBe(true);
		});
	});
});

describe('parseSegmentFilters throws on corrupt filters (callers decide)', () => {
	it('throws on an unknown condition kind', () => {
		expect(() =>
			parseSegmentFilters({ logic: 'AND', conditions: [{ kind: 'bogus' }] }),
		).toThrow();
	});

	it('throws on invalid JSON string', () => {
		expect(() => parseSegmentFilters('not json {{{')).toThrow();
	});
});

describe('matchLiveContacts (segment preview)', () => {
	it('excludes soft-deleted contacts (regression: the preview used to leak them)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await insertContact(ctx, { email: 'live@acme.com' });
			await insertContact(ctx, { email: 'gone@acme.com', deletedAt: Date.now() });

			const result = await matchLiveContacts(ctx, {
				logic: 'AND',
				conditions: [
					{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' },
				],
			});

			expect(result).toHaveLength(1);
			expect(result[0]!.email).toBe('live@acme.com');
		});
	});

	it('respects the limit', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) await insertContact(ctx, { email: `u${i}@acme.com` });

			const result = await matchLiveContacts(
				ctx,
				{
					logic: 'AND',
					conditions: [
						{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' },
					],
				},
				{ limit: 2 },
			);

			expect(result).toHaveLength(2);
		});
	});

	it('empty conditions returns first N live contacts (soft-deleted excluded)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await insertContact(ctx, { email: 'a@x.com' });
			await insertContact(ctx, { email: 'b@x.com' });
			await insertContact(ctx, { email: 'gone@x.com', deletedAt: Date.now() });

			const result = await matchLiveContacts(ctx, { logic: 'AND', conditions: [] }, { limit: 10 });
			expect(result).toHaveLength(2);
		});
	});

	it('returns [] on corrupt filters (lenient preview posture)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await insertContact(ctx);
			const result = await matchLiveContacts(ctx, 'not json {{{');
			expect(result).toEqual([]);
		});
	});
});

describe('countLiveMatches', () => {
	it('returns 0 on corrupt filters (lenient count posture)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await insertContact(ctx);
			expect(await countLiveMatches(ctx, 'not json {{{')).toBe(0);
		});
	});

	it('counts only matching live contacts', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await insertContact(ctx, { email: 'in@acme.com' });
			await insertContact(ctx, { email: 'out@other.com' });
			await insertContact(ctx, { email: 'gone@acme.com', deletedAt: Date.now() });

			const n = await countLiveMatches(ctx, {
				logic: 'AND',
				conditions: [
					{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' },
				],
			});
			expect(n).toBe(1);
		});
	});
});

describe('live-Contact streaming across the page boundary (ADR-0033)', () => {
	// CONTACT_PAGE_SIZE is 500; seed > 2 pages of live contacts so the paginated
	// stream must continue past `isDone === false`. Some matching contacts AND a
	// soft-deleted one are inserted LAST so they land on the final page — proving
	// the predicate and the soft-delete exclusion still apply on later pages.
	const ACME = 1100; // matching, live
	const OTHER = 50; // non-matching, live
	const acmeFilters = {
		logic: 'AND' as const,
		conditions: [
			{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' },
		],
	};

	async function seedLargeTable(ctx: MutationCtx) {
		for (let i = 0; i < ACME; i++) {
			await insertContact(ctx, { email: `acme${i}@acme.com` });
		}
		for (let i = 0; i < OTHER; i++) {
			await insertContact(ctx, { email: `other${i}@other.com` });
		}
		// A matching but soft-deleted contact, inserted last → final page.
		await insertContact(ctx, { email: 'gone@acme.com', deletedAt: Date.now() });
	}

	it('countLiveMatches sums matches across every page (excludes soft-deleted on the last page)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await seedLargeTable(ctx);
			expect(await countLiveMatches(ctx, acmeFilters)).toBe(ACME);
		});
	});

	it('matchLiveContacts returns every matching live contact across pages', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await seedLargeTable(ctx);
			const result = await matchLiveContacts(ctx, acmeFilters);
			expect(result).toHaveLength(ACME);
			expect(result.some((c) => c.email === 'gone@acme.com')).toBe(false);
		});
	});

	it('matchLiveContacts limit stops the stream before exhausting the table', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await seedLargeTable(ctx);
			const result = await matchLiveContacts(ctx, acmeFilters, { limit: 700 });
			expect(result).toHaveLength(700);
		});
	});

	it('empty conditions count every live contact across pages (soft-deleted excluded)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await seedLargeTable(ctx);
			expect(await countLiveMatches(ctx, { logic: 'AND', conditions: [] })).toBe(ACME + OTHER);
		});
	});

	it('countLiveMatchesForSegments shares one cross-page stream across segments', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await seedLargeTable(ctx);
			const counts = await countLiveMatchesForSegments(ctx, [
				{ segmentId: 'acme', filters: acmeFilters },
				{
					segmentId: 'other',
					filters: {
						logic: 'AND',
						conditions: [
							{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'other' },
						],
					},
				},
			]);
			expect(counts.get('acme')).toBe(ACME);
			expect(counts.get('other')).toBe(OTHER);
		});
	});
});

describe('email_activity condition (denormalized contact flags)', () => {
	const openedTrue = {
		logic: 'AND' as const,
		conditions: [{ kind: 'email_activity', field: 'opened', operator: 'is_true' }],
	};
	const openedFalse = {
		logic: 'AND' as const,
		conditions: [{ kind: 'email_activity', field: 'opened', operator: 'is_false' }],
	};

	it('reads hasOpened off the contact row (no contactActivities scan)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const opened = await insertContact(ctx, { email: 'opened@acme.com', hasOpened: true });
			const never = await insertContact(ctx, { email: 'never@acme.com' });

			const parsedTrue = parseSegmentFilters(openedTrue);
			const matchesTrue = makeSegmentPredicate(
				parsedTrue,
				await preloadConditionsLookup(ctx, parsedTrue.conditions),
			);
			expect(matchesTrue(opened)).toBe(true);
			expect(matchesTrue(never)).toBe(false);

			const parsedFalse = parseSegmentFilters(openedFalse);
			const matchesFalse = makeSegmentPredicate(
				parsedFalse,
				await preloadConditionsLookup(ctx, parsedFalse.conditions),
			);
			expect(matchesFalse(opened)).toBe(false);
			expect(matchesFalse(never)).toBe(true);
		});
	});

	it('the activity writer sets the flag end-to-end (idempotent on repeat opens)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const c = await insertContact(ctx, { email: 'e2e@acme.com' });
			expect(c.hasOpened).toBeUndefined();

			await recordContactActivity(ctx, {
				literal: 'email_opened',
				contactId: c._id,
				metadata: { campaignId: 'camp_1' },
			});
			expect((await ctx.db.get(c._id))!.hasOpened).toBe(true);

			// A second open is a no-op for the flag (already true) and must not throw.
			await recordContactActivity(ctx, {
				literal: 'email_opened',
				contactId: c._id,
				metadata: {},
			});
			expect((await ctx.db.get(c._id))!.hasOpened).toBe(true);

			// The segment condition now matches the engaged contact.
			const parsed = parseSegmentFilters(openedTrue);
			const matches = makeSegmentPredicate(
				parsed,
				await preloadConditionsLookup(ctx, parsed.conditions),
			);
			expect(matches((await ctx.db.get(c._id))!)).toBe(true);
		});
	});
});

describe('evaluateAgainstContact (single-contact case)', () => {
	it('evaluates one condition against one contact', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const contact = await insertContact(ctx, { source: 'import' });
			const result = await evaluateAgainstContact(
				ctx,
				parseSegmentFilters({
					logic: 'AND',
					conditions: [{ kind: 'contact_property', field: 'source', operator: 'equals', value: 'import' }],
				}).conditions,
				'AND',
				contact,
			);
			expect(result).toBe(true);
		});
	});

	it('resolves a CUSTOM contact_property via per-contact point read (no whole-column collect)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const propertyId = await ctx.db.insert('contactProperties', {
				key: 'plan',
				label: 'Plan',
				type: 'string',
				createdAt: Date.now(),
			});
			const contact = await insertContact(ctx, { email: 'pro@acme.com' });
			await ctx.db.insert('contactPropertyValues', {
				contactId: contact._id,
				propertyId,
				value: 'pro',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});

			const cond = (value: string) =>
				parseSegmentFilters({
					logic: 'AND',
					conditions: [{ kind: 'contact_property', field: 'plan', operator: 'equals', value }],
				}).conditions;

			expect(await evaluateAgainstContact(ctx, cond('pro'), 'AND', contact)).toBe(true);
			expect(await evaluateAgainstContact(ctx, cond('free'), 'AND', contact)).toBe(false);
		});
	});

	it('resolves topic_membership via per-contact point read', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const topicId = await ctx.db.insert('topics', {
				name: 'Newsletter',
				createdAt: Date.now(),
			});
			const member = await insertContact(ctx, { email: 'member@acme.com' });
			const outsider = await insertContact(ctx, { email: 'outsider@acme.com' });
			await ctx.db.insert('contactTopics', {
				contactId: member._id,
				topicId,
				addedAt: Date.now(),
			});

			const inTopic = parseSegmentFilters({
				logic: 'AND',
				conditions: [{ kind: 'topic_membership', topicId, operator: 'equals' }],
			}).conditions;

			expect(await evaluateAgainstContact(ctx, inTopic, 'AND', member)).toBe(true);
			expect(await evaluateAgainstContact(ctx, inTopic, 'AND', outsider)).toBe(false);
		});
	});
});

describe('countMatchingContactsPage (cursor-checkpointed audience walk)', () => {
	const acmeFilters = {
		logic: 'AND' as const,
		conditions: [
			{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' },
		],
	};

	it('sums matches across pages via the walker, excluding soft-deleted', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 7; i++) await insertContact(ctx, { email: `acme${i}@acme.com` });
			for (let i = 0; i < 3; i++) await insertContact(ctx, { email: `other${i}@other.com` });
			await insertContact(ctx, { email: 'gone@acme.com', deletedAt: Date.now() });

			// Walk in pages of 4 (forces > 1 page), accumulating like the action.
			let cursor: string | null = null;
			let total = 0;
			let scanned = 0;
			for (;;) {
				const page = await countMatchingContactsPage(ctx, acmeFilters, cursor, 4);
				total += page.matched;
				scanned += page.scanned;
				if (page.isDone || page.continueCursor === null) break;
				cursor = page.continueCursor;
			}
			expect(total).toBe(7); // soft-deleted acme contact excluded
			expect(scanned).toBe(10); // live population only
		});
	});

	it('empty conditions count every live contact', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) await insertContact(ctx, { email: `u${i}@x.com` });
			const page = await countMatchingContactsPage(ctx, { logic: 'AND', conditions: [] }, null, 100);
			expect(page.matched).toBe(5);
			expect(page.isDone).toBe(true);
		});
	});
});

describe('listMatchingContactsPage (cursor-checkpointed membership walk)', () => {
	const acmeFilters = {
		logic: 'AND' as const,
		conditions: [
			{ kind: 'contact_property', field: 'email', operator: 'contains', value: 'acme' },
		],
	};

	it('returns the matching members across pages, excluding soft-deleted', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 7; i++) await insertContact(ctx, { email: `acme${i}@acme.com` });
			for (let i = 0; i < 3; i++) await insertContact(ctx, { email: `other${i}@other.com` });
			await insertContact(ctx, { email: 'gone@acme.com', deletedAt: Date.now() });

			// Walk in pages of 4 (forces > 1 page), accumulating like the query caller.
			let cursor: string | null = null;
			const emails: string[] = [];
			for (;;) {
				const page = await listMatchingContactsPage(ctx, acmeFilters, cursor, 4);
				for (const m of page.members) emails.push(m.email!);
				if (page.isDone) break;
				cursor = page.continueCursor;
			}
			expect(emails).toHaveLength(7); // soft-deleted acme contact excluded
			expect(emails).not.toContain('gone@acme.com');
			expect(emails.every((e) => e.includes('acme'))).toBe(true);
		});
	});

	it('empty conditions return every live contact', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (let i = 0; i < 5; i++) await insertContact(ctx, { email: `u${i}@x.com` });
			const page = await listMatchingContactsPage(ctx, { logic: 'AND', conditions: [] }, null, 100);
			expect(page.members).toHaveLength(5);
			expect(page.isDone).toBe(true);
		});
	});

	it('returns an empty, done page on corrupt filters (lenient posture)', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await insertContact(ctx);
			const page = await listMatchingContactsPage(ctx, 'not json {{{', null, 100);
			expect(page.members).toEqual([]);
			expect(page.isDone).toBe(true);
		});
	});
});
