/**
 * What `contacts/import.ts:importBatch` answers and writes for a batch: the
 * exact outcome counters, the capped error list and its order, the activity
 * rows (one clock for the batch, the summary key of a property update), the
 * DOI attest, and how topic subscriptions count and fail.
 *
 * `contactImport.integration.test.ts` covers each policy on its own; this
 * suite pins the combined answer so the handler can be split without moving
 * what it writes.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { modules } from './testModulesWithoutNodeActions';

type Harness = TestConvex<typeof schema>;

const NOW = 1_700_000_000_000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

const importBatch = (t: Harness, args: Record<string, unknown>) =>
	t.mutation(internal.contacts.import.importBatch, {
		source: 'csv',
		handleDuplicates: 'skip',
		...args,
	} as never);

const createTopic = (t: Harness, requireDoubleOptIn: boolean) =>
	t.run((ctx) => ctx.db.insert('topics', { name: 'News', requireDoubleOptIn, createdAt: NOW }));

const createProperty = (t: Harness, key: string) =>
	t.run((ctx) =>
		ctx.db.insert('contactProperties', { key, label: key, type: 'string', createdAt: NOW })
	);

const activities = (t: Harness) => t.run((ctx) => ctx.db.query('contactActivities').collect());

describe('importBatch: the outcome', () => {
	it('answers every counter for a mixed batch, errors in row order', async () => {
		const t = convexTest(schema, modules);
		await createProperty(t, 'company');
		await importBatch(t, { rows: [{ email: 'known@example.com' }] });

		const result = await importBatch(t, {
			rows: [
				{ email: 'New@Example.com', properties: { company: 'Acme', unknown_key: 'x' } },
				{ email: 'new@example.com' },
				{ email: 'not-an-email' },
				{ email: 'known@example.com', properties: { unknown_key: 'y' } },
			],
		});

		expect(result).toEqual({
			imported: 1,
			updated: 0,
			// One within-batch duplicate, one existing contact under `skip`.
			skipped: 2,
			failed: 1,
			errors: [
				'Invalid email: not-an-email',
				"Property 'unknown_key' is not registered; values dropped for 2 row(s).",
			],
			addedToTopics: 0,
			propertiesSet: 1,
			propertiesAutoRegistered: 0,
			propertiesSkipped: 2,
			activitiesRecorded: 1,
		});
	});

	it('caps the error list at fifty and drops the summary lines past it', async () => {
		const t = convexTest(schema, modules);
		const rows = Array.from({ length: 60 }, (_, i) => ({ email: `bad-${i}` }));

		const result = await importBatch(t, {
			rows: [...rows, { email: 'ok@example.com', properties: { unknown_key: 'x' } }],
		});

		expect(result.failed).toBe(60);
		expect(result.errors).toHaveLength(50);
		expect(result.errors[49]).toBe('Invalid email: bad-49');
		expect(result.propertiesSkipped).toBe(1);
		expect(result.imported).toBe(1);
	});
});

describe('importBatch: activity rows', () => {
	it('stamps every created row with the one batch clock', async () => {
		const t = convexTest(schema, modules);

		await importBatch(t, { rows: [{ email: 'a@example.com' }, { email: 'b@example.com' }] });

		const rows = await activities(t);
		expect(rows.map((row) => [row.activityType, row.occurredAt, row.metadata])).toEqual([
			['created', NOW, { source: 'import' }],
			['created', NOW, { source: 'import' }],
		]);
	});

	it("names a property update after the row's first non-empty key, even a dropped one", async () => {
		const t = convexTest(schema, modules);
		await createProperty(t, 'company');
		await importBatch(t, { rows: [{ email: 'a@example.com' }] });

		await importBatch(t, {
			handleDuplicates: 'update',
			rows: [
				{
					email: 'a@example.com',
					// Stored records come back key-sorted: `alpha_unknown` is first.
					properties: { company: 'Acme', blank: '', alpha_unknown: 'x' },
				},
			],
		});

		const updates = (await activities(t)).filter((row) => row.activityType === 'property_updated');
		expect(updates).toHaveLength(1);
		expect(updates[0]?.metadata).toEqual({
			propertyKey: 'alpha_unknown',
			newValue: '1 value(s) updated',
		});
	});
});

describe('importBatch: DOI attest and topics', () => {
	it('attests with the triggering user before subscribing', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, true);

		const result = await importBatch(t, {
			rows: [{ email: 'a@example.com' }],
			topicAssignments: { kind: 'single', topicId },
			doiAttest: { attestSource: 'paper form', triggeredBy: 'user-A' },
		});

		expect(result.addedToTopics).toBe(1);
		const contact = await t.run((ctx) => ctx.db.query('contacts').first());
		expect(contact?.doiStatus).toBe('confirmed');
		const membership = await t.run((ctx) => ctx.db.query('contactTopics').first());
		expect(membership).toMatchObject({ contactId: contact?._id, topicId });
		expect(membership?.pendingDoiConfirmation).toBeUndefined();
	});

	it('counts a membership left waiting for confirmation as added', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, true);

		const result = await importBatch(t, {
			rows: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
			topicAssignments: { kind: 'single', topicId },
		});

		expect(result.addedToTopics).toBe(2);
	});

	it('subscribes per row only the contacts the map names', async () => {
		const t = convexTest(schema, modules);
		const first = await createTopic(t, false);
		const second = await createTopic(t, false);

		const result = await importBatch(t, {
			rows: [{ email: 'A@example.com' }, { email: 'b@example.com' }, { email: 'c@example.com' }],
			topicAssignments: {
				kind: 'per_row',
				map: { 'a@example.com': [first, second], 'c@example.com': [] },
			},
		});

		expect(result.addedToTopics).toBe(2);
		const memberships = await t.run((ctx) => ctx.db.query('contactTopics').collect());
		expect(memberships.map((row) => row.topicId).sort()).toEqual([first, second].sort());
	});

	it('counts nothing for a topic that no longer exists, without failing the rows', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);
		await t.run((ctx) => ctx.db.delete(topicId as Id<'topics'>));

		const result = await importBatch(t, {
			rows: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
			topicAssignments: { kind: 'single', topicId },
		});

		expect(result.imported).toBe(2);
		expect(result.addedToTopics).toBe(0);
		expect(result.errors).toEqual([]);
		expect(await t.run((ctx) => ctx.db.query('contactTopics').collect())).toEqual([]);
	});
});
