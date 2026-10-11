/**
 * Sender memory follows a contact merge (ADR-0073, D12): the merge repoints the
 * source's Team Inbox entries onto the survivor, so erasing the survivor later
 * deletes them, and none is left pointing at the deleted source.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestContact } from './factories';
import { modules } from '../mail/__tests__/helpers.testlib';
import { permanentlyDeleteContactWithRelations } from '../lib/contactMutations';

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
	return {
		...actual,
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const NOW = Date.UTC(2026, 9, 12);

function memoryRow(contactId: Id<'contacts'>, senderDigest: string) {
	return {
		scope: 'team_inbox' as const,
		contactId,
		senderDigest,
		authBasis: 'dmarc_pass' as const,
		task: 'mail.category' as const,
		matchKind: 'exact' as const,
		matchKey: `hash-${senderDigest}`,
		policyVersion: 1,
		modelIdentity: 'typesafe/jev-1.13.0',
		outcome: JSON.stringify({ category: 'notification' }),
		outcomeVersion: 1,
		hitCount: 0,
		expiresAt: NOW + 86_400_000,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

describe('sender memory across a contact merge', () => {
	it('moves to the survivor and goes with the survivor’s erasure', async () => {
		const t = convexTest(schema, modules);
		const { targetId, sourceId } = await t.run(async (ctx) => {
			const targetId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'target@example.com' })
			);
			const sourceId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'source@example.com' })
			);
			await ctx.db.insert('senderMemory', memoryRow(targetId, 'target-digest'));
			await ctx.db.insert('senderMemory', memoryRow(sourceId, 'source-digest'));
			return { targetId, sourceId };
		});

		await t.mutation(api.contacts.identities.mergeContacts, {
			targetContactId: targetId,
			sourceContactId: sourceId,
		});

		await t.run(async (ctx) => {
			const onSource = await ctx.db
				.query('senderMemory')
				.withIndex('by_contact', (q) => q.eq('contactId', sourceId))
				.collect();
			expect(onSource).toEqual([]);
			const onTarget = await ctx.db
				.query('senderMemory')
				.withIndex('by_contact', (q) => q.eq('contactId', targetId))
				.collect();
			expect(onTarget.map((row) => row.senderDigest).sort()).toEqual([
				'source-digest',
				'target-digest',
			]);
		});

		await t.run((ctx) =>
			permanentlyDeleteContactWithRelations(ctx, targetId, { decrementCount: false })
		);
		await t.run(async (ctx) => {
			expect(await ctx.db.query('senderMemory').collect()).toEqual([]);
		});
	});
});
