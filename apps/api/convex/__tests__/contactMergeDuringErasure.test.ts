/**
 * A merge must not reach into a contact that is being erased (#1337). Moving
 * the rows of a contact under erasure onto a live one takes them out of the
 * erasure's reach: the walk then "finishes" with personal data left behind on
 * the survivor. Both merge paths refuse instead, before anything moves.
 */

import { describe, expect, it, vi } from 'vitest';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { createTestContact, createTestContactIdentity } from './factories';
import { newHarness } from './testModules';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'admin-1', role: 'owner' }),
	};
});

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return { ...actual, decrementContactCount: vi.fn().mockResolvedValue(undefined) };
});

const NOW = Date.UTC(2026, 9, 14);
const DAY = 86_400_000;

async function addAnswer(ctx: MutationCtx, contactId: Id<'contacts'>, questionKey: string) {
	await ctx.db.insert('clarificationMemory', {
		contactId,
		slotType: 'date',
		questionKey,
		questionText: `${questionKey}?`,
		answerValue: 'answer',
		source: 'agent',
		answerCount: 1,
		useCount: 0,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

async function addOverride(ctx: MutationCtx, contactId: Id<'contacts'>) {
	await ctx.db.insert('draftStrategySelections', {
		organizationId: 'org-1',
		scopeType: 'contact',
		scopeId: contactId,
		strategyKind: 'concise',
		createdAt: NOW,
		updatedAt: NOW,
	});
}

/** A job for `contactId` that erases one row per transaction. */
async function startJob(ctx: MutationCtx, contactId: Id<'contacts'>) {
	return ctx.db.insert('contactErasureJobs', {
		contactId,
		reason: 'retention',
		status: 'running',
		phase: 'clarificationMemory',
		rowsProcessed: 0,
		transactions: 0,
		attempts: 0,
		rowCap: 1,
		createdAt: NOW,
		updatedAt: NOW,
	});
}

/** Rows of either table that still point at `contactId`. */
async function rowsOn(ctx: MutationCtx, contactId: Id<'contacts'>) {
	const answers = await ctx.db
		.query('clarificationMemory')
		.withIndex('by_contact_slot', (q) => q.eq('contactId', contactId))
		.collect();
	const overrides = await ctx.db
		.query('draftStrategySelections')
		.withIndex('by_scope', (q) => q.eq('scopeType', 'contact').eq('scopeId', contactId))
		.collect();
	return { answers: answers.length, overrides: overrides.length };
}

describe('merging while an erasure is under way', () => {
	it('refuses a source mid-erasure, and the erasure still clears it', async () => {
		const t = newHarness();
		const { targetId, sourceId, jobId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert(
				'contacts',
				createTestContact({ deletedAt: NOW - 40 * DAY })
			);
			await addAnswer(ctx, sourceId, 'date::deadline');
			await addAnswer(ctx, sourceId, 'date::start');
			await addOverride(ctx, sourceId);
			return { targetId, sourceId, jobId: await startJob(ctx, sourceId) };
		});

		// One transaction at one row: one answer gone, one left.
		expect(await t.mutation(internal.contacts.erasure.walker.tick, { jobId })).toBe('more');
		expect(await t.run((ctx) => rowsOn(ctx, sourceId))).toEqual({ answers: 1, overrides: 1 });

		await expect(
			t.mutation(api.contacts.identities.mergeContacts, {
				targetContactId: targetId,
				sourceContactId: sourceId,
			})
		).rejects.toThrow('A deleted contact cannot be merged');
		expect(await t.run((ctx) => rowsOn(ctx, targetId))).toEqual({ answers: 0, overrides: 0 });

		let outcome = 'more';
		for (let i = 0; i < 20 && outcome === 'more'; i++) {
			outcome = await t.mutation(internal.contacts.erasure.walker.tick, { jobId });
		}
		expect(outcome).toBe('done');
		expect(await t.run((ctx) => rowsOn(ctx, sourceId))).toEqual({ answers: 0, overrides: 0 });
		expect(await t.run((ctx) => ctx.db.get(sourceId))).toBeNull();
		expect(await t.run((ctx) => ctx.db.get(targetId))).not.toBeNull();
	});

	it('refuses a soft-deleted target', async () => {
		const t = newHarness();
		const { targetId, sourceId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact({ deletedAt: NOW }));
			const sourceId = await ctx.db.insert('contacts', createTestContact());
			await addAnswer(ctx, sourceId, 'date::deadline');
			return { targetId, sourceId };
		});

		await expect(
			t.mutation(api.contacts.identities.mergeContacts, {
				targetContactId: targetId,
				sourceContactId: sourceId,
			})
		).rejects.toThrow('A deleted contact cannot be merged');
		expect(await t.run((ctx) => rowsOn(ctx, sourceId))).toEqual({ answers: 1, overrides: 0 });
	});

	it('refuses a live contact that has an erasure job', async () => {
		const t = newHarness();
		const { targetId, sourceId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());
			await addOverride(ctx, sourceId);
			await startJob(ctx, sourceId);
			return { targetId, sourceId };
		});

		await expect(
			t.mutation(api.contacts.identities.mergeContacts, {
				targetContactId: targetId,
				sourceContactId: sourceId,
			})
		).rejects.toThrow('A deleted contact cannot be merged');
		expect(await t.run((ctx) => rowsOn(ctx, sourceId))).toEqual({ answers: 0, overrides: 1 });
	});

	it('auto-merge leaves a duplicate pair alone while one side is being erased', async () => {
		const t = newHarness();
		const { targetId, sourceId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert('contacts', createTestContact());
			const sourceId = await ctx.db.insert('contacts', createTestContact());
			for (const contactId of [targetId, sourceId]) {
				await ctx.db.insert(
					'contactIdentities',
					createTestContactIdentity({ contactId, identifier: 'shared@example.com' })
				);
			}
			await addAnswer(ctx, sourceId, 'date::deadline');
			await startJob(ctx, sourceId);
			return { targetId, sourceId };
		});

		expect(await t.mutation(internal.contacts.identities.autoMergeDuplicates, {})).toEqual({
			merged: 0,
		});
		expect(await t.run((ctx) => ctx.db.get(sourceId))).not.toBeNull();
		expect(await t.run((ctx) => rowsOn(ctx, sourceId))).toEqual({ answers: 1, overrides: 0 });
		expect(await t.run((ctx) => rowsOn(ctx, targetId))).toEqual({ answers: 0, overrides: 0 });
	});
});
