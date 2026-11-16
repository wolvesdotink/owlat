/**
 * Migration 0076 writes the missing `userProfiles` row of every org member who
 * joined without one, so they can be added to team inboxes, chats and threads.
 */

import { describe, expect, it } from 'vitest';
import { components, internal } from '../../_generated/api';
import { newBetterAuthHarness } from '../../__tests__/testModules';

const MIGRATION = '0076_backfill_member_profiles';
const migration = internal.migrations[MIGRATION];

type Harness = ReturnType<typeof newBetterAuthHarness>;

async function createRow(t: Harness, model: string, data: Record<string, unknown>) {
	const row = (await t.mutation(components.betterAuth.adapter.create, {
		input: { model, data },
	} as never)) as { _id: string };
	return row._id;
}

async function addMember(t: Harness, organizationId: string, email: string, name: string) {
	const userId = await createRow(t, 'user', {
		email,
		name,
		emailVerified: true,
		createdAt: 1,
		updatedAt: 1,
	});
	await createRow(t, 'member', { userId, organizationId, role: 'editor', createdAt: 1 });
	return userId;
}

function profiles(t: Harness) {
	return t.run((ctx) => ctx.db.query('userProfiles').collect());
}

function ledger(t: Harness) {
	return t.run((ctx) =>
		ctx.db
			.query('migrationRuns')
			.withIndex('by_migration', (q) => q.eq('migration', MIGRATION))
			.unique()
	);
}

describe('0076_backfill_member_profiles', () => {
	it('creates the profile of a member who has none and leaves existing ones alone', async () => {
		const t = newBetterAuthHarness();
		const organizationId = await createRow(t, 'organization', {
			name: 'Team',
			slug: 'team',
			createdAt: 1,
		});
		const ownerId = await addMember(t, organizationId, 'owner@example.com', 'Owner');
		await t.run((ctx) =>
			ctx.db.insert('userProfiles', {
				authUserId: ownerId,
				email: 'owner@example.com',
				name: 'Owner',
				createdAt: 1,
				updatedAt: 1,
			})
		);
		const joinerId = await addMember(t, organizationId, 'Joiner@Example.com', 'Joiner');

		expect(await t.mutation(migration.run, {})).toEqual({ started: true });
		expect(await t.mutation(migration.ensure, {})).toEqual({ started: false });

		expect(await profiles(t)).toEqual([
			expect.objectContaining({ authUserId: ownerId, email: 'owner@example.com' }),
			expect.objectContaining({
				authUserId: joinerId,
				email: 'joiner@example.com',
				name: 'Joiner',
			}),
		]);
		expect(await ledger(t)).toMatchObject({
			status: 'completed',
			scannedCount: 2,
			changedCount: 1,
		});
	});
});
