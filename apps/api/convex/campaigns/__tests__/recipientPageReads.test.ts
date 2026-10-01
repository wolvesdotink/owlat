/**
 * Recipient-page read cost (#915).
 *
 * The send walker resolves one page per hop. Every supporting read on that page
 * (segment condition lookups, the suppression gate) must be scoped to the
 * page's own rows, so a page costs the same whether the blocklist holds zero
 * addresses or fifty thousand, and whether the property/topic columns a
 * condition references hold a page's worth of rows or a whole population's.
 *
 * Cost is measured with an instrumented in-memory reader driving the REAL
 * `resolveRecipientPage` handler. The behavioural half (audience equivalence
 * with the count stream, suppression added between pages) runs on convex-test.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { resolveRecipientPage, type ResolvedPage } from '../audienceResolution';
import { streamAudienceCandidates } from '../audienceCandidates';
import type { StoredAudience } from '../audience';
import { createTestContact, createTestTopic } from '../../__tests__/factories';
import { createInstrumentedReader, type ReadCounters } from './helpers/instrumentedReader';

// Same glob re-prefixing as audienceResolution.test.ts (see the note there).
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).map(([key, val]) => {
		if (key.startsWith('../') && !key.startsWith('../../')) {
			return ['../../campaigns/' + key.slice(3), val];
		}
		return [key, val];
	})
);

// ── Instrumented cost ───────────────────────────────────────────────────

const PLAN = 'contactProperties:plan';
const TOPIC = 'topics:news';

/** A population where every contact carries a property value and a membership. */
function seedPopulation(contacts: number, suppressions: number) {
	const seed: Record<string, Array<Record<string, unknown>>> = {
		topics: [{ _id: TOPIC, name: 'News', requireDoubleOptIn: false }],
		contactProperties: [{ _id: PLAN, key: 'plan', label: 'Plan', type: 'string' }],
		contacts: [],
		contactPropertyValues: [],
		contactTopics: [],
		blockedEmails: [],
	};
	for (let i = 0; i < contacts; i++) {
		const _id = `contacts:${i}`;
		seed['contacts']!.push({ _id, email: `Person${i}@Example.com`, doiStatus: 'confirmed' });
		seed['contactPropertyValues']!.push({
			contactId: _id,
			propertyId: PLAN,
			value: i % 2 === 0 ? 'pro' : 'free',
		});
		seed['contactTopics']!.push({ contactId: _id, topicId: TOPIC, addedAt: 1 });
	}
	// Every 10th contact is blocked; the rest of the blocklist is unrelated.
	let blocked = 0;
	for (let i = 0; i < contacts && blocked < suppressions; i += 10, blocked++) {
		seed['blockedEmails']!.push({ email: `person${i}@example.com`, reason: 'bounced' });
	}
	for (let j = 0; blocked < suppressions; j++, blocked++) {
		seed['blockedEmails']!.push({ email: `gone${j}@elsewhere.test`, reason: 'bounced' });
	}
	return seed;
}

const segmentAudience = (conditions: unknown[]) =>
	({
		kind: 'segment',
		segmentId: 'segments:x',
		frozenFilters: { logic: 'AND', conditions },
	}) as unknown as StoredAudience;

const PRO_AND_NEWS = segmentAudience([
	{ kind: 'contact_property', field: 'plan', operator: 'equals', value: 'pro' },
	{ kind: 'topic_membership', topicId: TOPIC, operator: 'equals' },
]);
const NEWS_TOPIC = { kind: 'topic', topicId: TOPIC } as unknown as StoredAudience;

type Handler = (ctx: unknown, args: unknown) => Promise<ResolvedPage>;
const handler = (resolveRecipientPage as unknown as { _handler: Handler })._handler;

async function firstPageCost(
	population: { contacts: number; suppressions: number },
	audience: StoredAudience,
	numItems: number
): Promise<{ cost: ReadCounters; page: ResolvedPage }> {
	const reader = createInstrumentedReader(
		seedPopulation(population.contacts, population.suppressions)
	);
	const page = await handler({ db: reader.db }, { audience, cursor: '', numItems });
	return { cost: { ...reader.counters }, page };
}

describe('resolveRecipientPage — one page reads only what the page needs', () => {
	for (const [name, audience] of [
		['segment (property AND topic)', PRO_AND_NEWS],
		['topic', NEWS_TOPIC],
	] as const) {
		it(`${name}: page reads do not grow with unrelated contacts, values, memberships or suppressions`, async () => {
			const small = await firstPageCost({ contacts: 200, suppressions: 0 }, audience, 100);
			const large = await firstPageCost({ contacts: 4_000, suppressions: 4_000 }, audience, 100);

			// The same 100 contacts head both populations, and the same 10 of them
			// are blocked, so the page is identical and so is its cost — apart from
			// the blocklist rows it actually hits (the 0-suppression side reads none).
			expect(large.page.pageCandidates).toBe(small.page.pageCandidates);
			expect(large.cost.queries).toBe(small.cost.queries);
			expect(large.cost.documents - small.cost.documents).toBeLessThanOrEqual(10);
			// The whole-column preload read ≥ 4,000 values + 4,000 memberships +
			// 4,000 blocklist rows per page; a page-scoped page reads a few per contact.
			expect(large.cost.documents).toBeLessThanOrEqual(100 * 4);
		});
	}

	it('segment: shrinks the page when condition fan-out would exceed the per-page query budget', async () => {
		const reader = createInstrumentedReader(seedPopulation(2_000, 0));
		// Ten distinct topics ⇒ ten point reads per contact, plus suppression.
		for (let k = 0; k < 10; k++) reader.insert('topics', { _id: `topics:t${k}`, name: `t${k}` });
		const audience = segmentAudience(
			Array.from({ length: 10 }, (_, k) => ({
				kind: 'topic_membership',
				topicId: `topics:t${k}`,
				operator: 'not_equals',
			}))
		);

		const seen = new Set<string>();
		let cursor = '';
		let pages = 0;
		for (;;) {
			reader.reset();
			const page = await handler({ db: reader.db }, { audience, cursor, numItems: 500 });
			pages++;
			expect(reader.counters.queries).toBeLessThanOrEqual(3_000);
			expect(reader.counters.documents).toBeLessThanOrEqual(12_000);
			for (const r of page.recipients) seen.add(r._id);
			if (page.nextCursor === null) break;
			cursor = page.nextCursor;
		}
		// 11 queries per contact caps a page well below 500, and the walk still
		// reaches every contact (nobody is a member of the ten topics).
		expect(pages).toBeGreaterThan(4);
		expect(seen.size).toBe(2_000);
	});
});

// ── Behaviour on the real query engine ───────────────────────────────────

async function drain(
	t: TestConvex<typeof schema>,
	audience: StoredAudience,
	numItems: number,
	betweenPages?: (pageIndex: number) => Promise<void>
): Promise<string[]> {
	const emails: string[] = [];
	let cursor = '';
	for (let i = 0; ; i++) {
		const page = await t.query(internal.campaigns.audienceResolution.resolveRecipientPage, {
			audience,
			cursor,
			numItems,
		});
		emails.push(...page.recipients.map((r) => r.email));
		if (page.nextCursor === null) return emails;
		cursor = page.nextCursor;
		await betweenPages?.(i);
	}
}

async function streamEmails(
	t: TestConvex<typeof schema>,
	audience: StoredAudience
): Promise<string[]> {
	return await t.run(async (ctx) => {
		const out: string[] = [];
		for await (const { recipient } of streamAudienceCandidates(
			ctx as unknown as QueryCtx,
			audience
		)) {
			if (recipient) out.push(recipient.email);
		}
		return out;
	});
}

async function seedSegmentFixture(t: TestConvex<typeof schema>) {
	return await t.run(async (ctx) => {
		const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: true }));
		const propertyId = await ctx.db.insert('contactProperties', {
			key: 'plan',
			label: 'Plan',
			type: 'string',
			createdAt: 1,
		});
		const now = Date.now();
		for (let i = 0; i < 40; i++) {
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({
					email: `Seg${i}@Example.com`,
					// DOI never gates a segment, even for a DOI topic condition.
					doiStatus: i % 4 === 0 ? 'pending' : 'confirmed',
					...(i % 13 === 0 ? { unsubscribedAt: now } : {}),
					...(i % 17 === 0 ? { deletedAt: now } : {}),
				})
			);
			await ctx.db.insert('contactPropertyValues', {
				contactId,
				propertyId,
				value: i % 2 === 0 ? 'pro' : 'free',
				createdAt: now,
				updatedAt: now,
			});
			if (i % 3 !== 0) await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: now });
		}
		await ctx.db.insert('blockedEmails', {
			email: 'seg4@example.com',
			reason: 'bounced',
			createdAt: now,
		});
		return {
			topicId: topicId as Id<'topics'>,
			segmentId: await ctx.db.insert('segments', {
				name: 'fixture',
				filters: { logic: 'AND', conditions: [] },
				createdAt: now,
				updatedAt: now,
			}),
		};
	});
}

describe('resolveRecipientPage — page-scoped joins keep the audience', () => {
	it('AND, OR and negative conditions resolve the same recipients as the count stream', async () => {
		const t = convexTest(schema, modules);
		const { topicId, segmentId } = await seedSegmentFixture(t);
		const shapes = [
			{
				logic: 'AND',
				conditions: [
					{ kind: 'contact_property', field: 'plan', operator: 'equals', value: 'PRO' },
					{ kind: 'topic_membership', topicId, operator: 'equals' },
				],
			},
			{
				logic: 'OR',
				conditions: [
					{ kind: 'contact_property', field: 'plan', operator: 'not_equals', value: 'pro' },
					{ kind: 'topic_membership', topicId, operator: 'not_equals' },
				],
			},
		] as const;
		for (const frozenFilters of shapes) {
			const audience = { kind: 'segment', segmentId, frozenFilters } as unknown as StoredAudience;
			const paged = await drain(t, audience, 7);
			const streamed = await streamEmails(t, audience);
			expect(paged.length).toBeGreaterThan(0);
			expect(paged).toEqual(streamed);
			expect(paged).not.toContain('Seg4@Example.com'); // suppressed, case-folded
		}
	});

	it('an address suppressed between two pages is excluded from the later page', async () => {
		const t = convexTest(schema, modules);
		const { segmentId } = await seedSegmentFixture(t);
		const audience = {
			kind: 'segment',
			segmentId,
			frozenFilters: {
				logic: 'AND',
				conditions: [
					{ kind: 'contact_property', field: 'plan', operator: 'equals', value: 'free' },
				],
			},
		} as unknown as StoredAudience;

		const before = await drain(t, audience, 10);
		expect(before).toContain('Seg37@Example.com'); // on the last page

		const after = await drain(t, audience, 10, async (pageIndex) => {
			if (pageIndex !== 0) return;
			await t.run(async (ctx) => {
				await ctx.db.insert('blockedEmails', {
					email: 'seg37@example.com',
					reason: 'complained',
					createdAt: Date.now(),
				});
			});
		});
		expect(after).toEqual(before.filter((e) => e !== 'Seg37@Example.com'));
	});
});
