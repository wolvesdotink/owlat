/**
 * Integration tests for **Contact import (module)**.
 *
 * Covers per-source resolution, topic assignments (single + per-row),
 * property catalog policy (csv/api skip vs mailchimp/stripe auto-register),
 * DOI admin-attest, contact-count increment, contact-activity recording,
 * within-batch dedup, batch limit, and the four drift-bug regression cases
 * named in docs/adr/0019-contact-import-module.md.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const incrementContactCountMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: incrementContactCountMock,
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
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
			!path.includes('llmProvider'),
	),
);

async function createTopic(
	t: ReturnType<typeof convexTest>,
	requireDoubleOptIn: boolean,
	name = 'Newsletter',
): Promise<Id<'topics'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('topics', {
			name,
			requireDoubleOptIn,
			createdAt: Date.now(),
		});
	});
}

async function createProperty(
	t: ReturnType<typeof convexTest>,
	key: string,
	type: 'string' | 'number' | 'boolean' | 'date' = 'string',
): Promise<Id<'contactProperties'>> {
	return await t.run(async (ctx) => {
		return await ctx.db.insert('contactProperties', {
			key,
			label: key,
			type,
			createdAt: Date.now(),
		});
	});
}

// ─── Per-source resolution ──────────────────────────────────────────────────

describe('contacts.import.importBatch — per-source resolution', () => {
	it('csv import: handleDuplicates=skip resolves new contacts as imported', async () => {
		const t = convexTest(schema, modules);
		incrementContactCountMock.mockClear();

		const result = await t.mutation(
			internal.contacts.import.importBatch,
			{
				rows: [
					{ email: 'a@example.com', firstName: 'Alice' },
					{ email: 'b@example.com', firstName: 'Bob' },
				],
				source: 'csv',
				handleDuplicates: 'skip',
			},
		);

		expect(result.imported).toBe(2);
		expect(result.updated).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.failed).toBe(0);
		expect(incrementContactCountMock).toHaveBeenCalledWith(
			expect.anything(),
			2,
		);
	});

	it('csv import: handleDuplicates=skip on existing email resolves as matched (skipped)', async () => {
		const t = convexTest(schema, modules);
		// Pre-create a contact.
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'existing@example.com', firstName: 'Old' }],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		const result = await t.mutation(
			internal.contacts.import.importBatch,
			{
				rows: [{ email: 'existing@example.com', firstName: 'New' }],
				source: 'csv',
				handleDuplicates: 'skip',
			},
		);

		expect(result.imported).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.skipped).toBe(1);

		// First name should NOT have changed (skip mode = upsert resolve).
		const contacts = await t.run(async (ctx) => {
			return await ctx.db.query('contacts').collect();
		});
		expect(contacts.find((c) => c.email === 'existing@example.com')?.firstName).toBe(
			'Old',
		);
	});

	it('csv import: handleDuplicates=update merges non-empty fields on match', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'm@example.com', firstName: 'Old' }],
			source: 'csv',
			handleDuplicates: 'update',
		});

		const result = await t.mutation(
			internal.contacts.import.importBatch,
			{
				rows: [{ email: 'm@example.com', firstName: 'New' }],
				source: 'csv',
				handleDuplicates: 'update',
			},
		);

		expect(result.updated).toBe(1);
		expect(result.imported).toBe(0);

		const contacts = await t.run(async (ctx) => {
			return await ctx.db.query('contacts').collect();
		});
		expect(contacts.find((c) => c.email === 'm@example.com')?.firstName).toBe('New');
	});

	it('mailchimp import accepts source literal', async () => {
		const t = convexTest(schema, modules);
		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'mc@example.com' }],
			source: 'mailchimp',
			handleDuplicates: 'skip',
		});
		expect(result.imported).toBe(1);
	});

	it('stripe import accepts source literal', async () => {
		const t = convexTest(schema, modules);
		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'st@example.com' }],
			source: 'stripe',
			handleDuplicates: 'skip',
		});
		expect(result.imported).toBe(1);
	});
});

// ─── Within-batch dedup ─────────────────────────────────────────────────────

describe('contacts.import.importBatch — within-batch dedup', () => {
	it('counts within-batch email duplicates as skipped', async () => {
		const t = convexTest(schema, modules);
		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'd@example.com', firstName: 'First' },
				{ email: 'D@example.com', firstName: 'Second (dup)' },
				{ email: 'd@example.com', firstName: 'Third (dup)' },
			],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		expect(result.imported).toBe(1);
		expect(result.skipped).toBe(2);
	});
});

// ─── Email validation ───────────────────────────────────────────────────────

describe('contacts.import.importBatch — email validation', () => {
	it('records invalid emails in errors[] and increments failed', async () => {
		const t = convexTest(schema, modules);
		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'ok@example.com' },
				{ email: 'not-an-email' },
				{ email: 'no@dots' },
			],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		expect(result.imported).toBe(1);
		expect(result.failed).toBe(2);
		expect(result.errors.length).toBeGreaterThanOrEqual(2);
		expect(result.errors[0]).toMatch(/Invalid email/i);
	});

	it('empty-string emails are silently dropped by within-batch dedup', async () => {
		const t = convexTest(schema, modules);
		// `deduplicateContactsByEmail` strips empty/missing emails before the
		// validation loop sees them — preserves legacy behavior across all
		// three import shells. ADR-0019.
		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'ok@example.com' },
				{ email: '' },
			],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		expect(result.imported).toBe(1);
		expect(result.failed).toBe(0);
	});
});

// ─── Topic assignments ──────────────────────────────────────────────────────

describe('contacts.import.importBatch — topic assignments', () => {
	it('single topic: subscribes all imported contacts to one topic', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, false);

		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'a@example.com' },
				{ email: 'b@example.com' },
			],
			source: 'csv',
			handleDuplicates: 'skip',
			topicAssignments: { kind: 'single', topicId },
		});

		expect(result.addedToTopics).toBe(2);

		const memberships = await t.run(async (ctx) => {
			return await ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', topicId))
				.collect();
		});
		expect(memberships).toHaveLength(2);
	});

	it('per_row: subscribes each contact to their mapped topics', async () => {
		const t = convexTest(schema, modules);
		const topicA = await createTopic(t, false, 'A');
		const topicB = await createTopic(t, false, 'B');

		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'a@example.com' },
				{ email: 'b@example.com' },
			],
			source: 'csv',
			handleDuplicates: 'skip',
			topicAssignments: {
				kind: 'per_row',
				map: {
					'a@example.com': [topicA, topicB],
					'b@example.com': [topicB],
				},
			},
		});

		expect(result.addedToTopics).toBe(3);

		const memA = await t.run(async (ctx) => {
			return await ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', topicA))
				.collect();
		});
		const memB = await t.run(async (ctx) => {
			return await ctx.db
				.query('contactTopics')
				.withIndex('by_topic', (q) => q.eq('topicId', topicB))
				.collect();
		});
		expect(memA).toHaveLength(1);
		expect(memB).toHaveLength(2);
	});

	it('no topic assignments: writes no memberships', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		const memberships = await t.run(async (ctx) => {
			return await ctx.db.query('contactTopics').collect();
		});
		expect(memberships).toHaveLength(0);
	});
});

// ─── Property catalog policy ────────────────────────────────────────────────

describe('contacts.import.importBatch — property catalog policy', () => {
	it('csv import + known property key: writes contactPropertyValues', async () => {
		const t = convexTest(schema, modules);
		const propertyId = await createProperty(t, 'company');

		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'a@example.com', properties: { company: 'Acme' } },
			],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		expect(result.propertiesSet).toBe(1);
		expect(result.propertiesSkipped).toBe(0);
		expect(result.propertiesAutoRegistered).toBe(0);

		const values = await t.run(async (ctx) => {
			return await ctx.db
				.query('contactPropertyValues')
				.withIndex('by_property', (q) => q.eq('propertyId', propertyId))
				.collect();
		});
		expect(values).toHaveLength(1);
		expect(values[0]?.value).toBe('Acme');
	});

	it('csv import + unknown property key: skips, summarizes in errors[]', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'a@example.com', properties: { unknown_key: 'V1' } },
				{ email: 'b@example.com', properties: { unknown_key: 'V2' } },
			],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		expect(result.propertiesSet).toBe(0);
		expect(result.propertiesSkipped).toBe(2);
		expect(result.propertiesAutoRegistered).toBe(0);
		expect(result.errors.some((e) => /unknown_key/.test(e))).toBe(true);

		// Contacts still imported.
		expect(result.imported).toBe(2);
	});

	it('mailchimp import + unknown property key: auto-registers, writes value', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'a@example.com', properties: { COMPANY: 'Acme' } },
			],
			source: 'mailchimp',
			handleDuplicates: 'skip',
		});

		expect(result.propertiesSet).toBe(1);
		expect(result.propertiesAutoRegistered).toBe(1);
		expect(result.propertiesSkipped).toBe(0);

		const propertyRow = await t.run(async (ctx) => {
			return await ctx.db
				.query('contactProperties')
				.withIndex('by_key', (q) => q.eq('key', 'COMPANY'))
				.first();
		});
		expect(propertyRow).toBeTruthy();
		expect(propertyRow?.autoRegistered).toBe(true);
		expect(propertyRow?.autoRegisteredSource).toBe('mailchimp');
	});

	it('mailchimp import + same unknown key across multiple rows: registers once, writes per row', async () => {
		const t = convexTest(schema, modules);

		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'a@example.com', properties: { TIER: 'gold' } },
				{ email: 'b@example.com', properties: { TIER: 'silver' } },
			],
			source: 'mailchimp',
			handleDuplicates: 'skip',
		});

		expect(result.propertiesSet).toBe(2);
		expect(result.propertiesAutoRegistered).toBe(1);

		const rows = await t.run(async (ctx) => {
			return await ctx.db
				.query('contactProperties')
				.withIndex('by_key', (q) => q.eq('key', 'TIER'))
				.collect();
		});
		expect(rows).toHaveLength(1);
	});

	it('property type inference: number value yields type=number', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com', properties: { credits: 100 } }],
			source: 'mailchimp',
			handleDuplicates: 'skip',
		});

		const row = await t.run(async (ctx) => {
			return await ctx.db
				.query('contactProperties')
				.withIndex('by_key', (q) => q.eq('key', 'credits'))
				.first();
		});
		expect(row?.type).toBe('number');
	});

	it('property type inference: boolean value yields type=boolean', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com', properties: { vip: true } }],
			source: 'stripe',
			handleDuplicates: 'skip',
		});

		const row = await t.run(async (ctx) => {
			return await ctx.db
				.query('contactProperties')
				.withIndex('by_key', (q) => q.eq('key', 'vip'))
				.first();
		});
		expect(row?.type).toBe('boolean');
	});

	it('null and empty property values are silently dropped', async () => {
		const t = convexTest(schema, modules);
		await createProperty(t, 'company');

		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{
					email: 'a@example.com',
					properties: { company: null, empty: '' },
				},
			],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		expect(result.propertiesSet).toBe(0);
		expect(result.propertiesSkipped).toBe(0); // null is not "unknown", just dropped
	});
});

// ─── DOI attest ─────────────────────────────────────────────────────────────

describe('contacts.import.importBatch — DOI attest', () => {
	it('doiAttest on fresh contact: sets doiStatus=confirmed and writes attestedSource', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'mailchimp',
			handleDuplicates: 'skip',
			doiAttest: { attestSource: 'mailchimp' },
		});

		const contact = await t.run(async (ctx) => {
			return await ctx.db
				.query('contacts')
				.withIndex('by_email', (q) => q.eq('email', 'a@example.com'))
				.first();
		});
		expect(contact?.doiStatus).toBe('confirmed');
		expect(contact?.doiAttestedSource).toBe('mailchimp');
		expect(contact?.doiConfirmedAt).toBeTypeOf('number');
	});

	it('doiAttest emits doi_attested contact activity and doi.admin_attested audit log', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'mailchimp',
			handleDuplicates: 'skip',
			doiAttest: { attestSource: 'mailchimp' },
		});

		const activities = await t.run(async (ctx) => {
			return await ctx.db.query('contactActivities').collect();
		});
		const attested = activities.find((a) => a.activityType === 'doi_attested');
		expect(attested).toBeTruthy();
		expect(
			(attested?.metadata as { attestSource?: string } | undefined)?.attestSource,
		).toBe('mailchimp');

		const auditLogs = await t.run(async (ctx) => {
			return await ctx.db.query('auditLogs').collect();
		});
		const attestAudit = auditLogs.find((l) => l.action === 'doi.admin_attested');
		expect(attestAudit).toBeTruthy();
	});

	it('doiAttest + DOI-required topic in same batch: subscribes immediately (no confirmation email)', async () => {
		const t = convexTest(schema, modules);
		const topicId = await createTopic(t, true);

		const result = await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'mailchimp',
			handleDuplicates: 'skip',
			topicAssignments: { kind: 'single', topicId },
			doiAttest: { attestSource: 'mailchimp' },
		});

		expect(result.addedToTopics).toBe(1);

		const contact = await t.run(async (ctx) => {
			return await ctx.db
				.query('contacts')
				.withIndex('by_email', (q) => q.eq('email', 'a@example.com'))
				.first();
		});
		// confirmed before subscribeMany → no pending token, no confirmation email
		expect(contact?.doiStatus).toBe('confirmed');
		expect(contact?.doiConfirmationToken).toBeUndefined();
	});

	it('doiAttest is idempotent when contact already confirmed', async () => {
		const t = convexTest(schema, modules);

		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'mailchimp',
			handleDuplicates: 'skip',
			doiAttest: { attestSource: 'mailchimp' },
		});

		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'mailchimp',
			handleDuplicates: 'update',
			doiAttest: { attestSource: 'mailchimp' },
		});

		// Only one doi_attested activity row should exist.
		const activities = await t.run(async (ctx) => {
			return await ctx.db
				.query('contactActivities')
				.filter((q) => q.eq(q.field('activityType'), 'doi_attested'))
				.collect();
		});
		expect(activities).toHaveLength(1);
	});
});

// ─── Activity recording ─────────────────────────────────────────────────────

describe('contacts.import.importBatch — contact activity', () => {
	it('newly-created contact gets one created activity', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		const activities = await t.run(async (ctx) => {
			return await ctx.db.query('contactActivities').collect();
		});
		const created = activities.filter((a) => a.activityType === 'created');
		expect(created).toHaveLength(1);
		expect(
			(created[0]?.metadata as { source?: string } | undefined)?.source,
		).toBe('import');
	});

	it('existing contact + property writes: one property_updated activity', async () => {
		const t = convexTest(schema, modules);
		await createProperty(t, 'company');

		// First import: contact gets created activity.
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		// Second import: property write triggers property_updated.
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'a@example.com', properties: { company: 'Acme' } },
			],
			source: 'csv',
			handleDuplicates: 'update',
		});

		const activities = await t.run(async (ctx) => {
			return await ctx.db.query('contactActivities').collect();
		});
		const propertyUpdates = activities.filter(
			(a) => a.activityType === 'property_updated',
		);
		expect(propertyUpdates).toHaveLength(1);
	});

	it('existing contact + no property writes: no property_updated activity', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'csv',
			handleDuplicates: 'skip',
		});
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'csv',
			handleDuplicates: 'update',
		});

		const activities = await t.run(async (ctx) => {
			return await ctx.db.query('contactActivities').collect();
		});
		const propertyUpdates = activities.filter(
			(a) => a.activityType === 'property_updated',
		);
		expect(propertyUpdates).toHaveLength(0);
	});
});

// ─── incrementContactCount ──────────────────────────────────────────────────

describe('contacts.import.importBatch — incrementContactCount', () => {
	it('increments by `imported` count regardless of source', async () => {
		const t = convexTest(schema, modules);
		incrementContactCountMock.mockClear();

		await t.mutation(internal.contacts.import.importBatch, {
			rows: [
				{ email: 'a@example.com' },
				{ email: 'b@example.com' },
			],
			source: 'mailchimp',
			handleDuplicates: 'skip',
		});

		expect(incrementContactCountMock).toHaveBeenCalledTimes(1);
		expect(incrementContactCountMock).toHaveBeenCalledWith(
			expect.anything(),
			2,
		);
	});

	it('zero imported (all duplicates): no incrementContactCount call', async () => {
		const t = convexTest(schema, modules);

		// Pre-create.
		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		incrementContactCountMock.mockClear();

		await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'a@example.com' }],
			source: 'csv',
			handleDuplicates: 'skip',
		});

		expect(incrementContactCountMock).not.toHaveBeenCalled();
	});
});

// ─── Batch size limit ───────────────────────────────────────────────────────

describe('contacts.import.importBatch — batch size limit', () => {
	it('throws when batch exceeds 500 rows', async () => {
		const t = convexTest(schema, modules);
		const rows = Array.from({ length: 501 }, (_, i) => ({
			email: `u${i}@example.com`,
		}));

		await expect(
			t.mutation(internal.contacts.import.importBatch, {
				rows,
				source: 'csv',
				handleDuplicates: 'skip',
			}),
		).rejects.toThrow(/more than 500/);
	});

	it('accepts exactly 500 rows', async () => {
		const t = convexTest(schema, modules);
		const rows = Array.from({ length: 500 }, (_, i) => ({
			email: `u${i}@example.com`,
		}));

		const result = await t.mutation(
			internal.contacts.import.importBatch,
			{
				rows,
				source: 'csv',
				handleDuplicates: 'skip',
			},
		);
		expect(result.imported).toBe(500);
	});
});
