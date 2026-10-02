import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../_generated/dataModel';
import {
	type Harness,
	drainScheduled,
	erasureHarness,
	requestOf,
	runDeletionCron,
	seedEditor,
	seedIdentity,
	seedMembership,
	seedPersonalMailbox,
} from './memberErasureFixtures';

/**
 * Saved replies under member erasure: the member's personal replies go
 * (including ones written before saved replies, on their personal mailbox);
 * the shared replies they wrote stay with the organization, without their
 * name on them; a colleague's replies are untouched.
 */

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

function reply(name: string, fields: Record<string, unknown>) {
	return {
		name,
		shortcut: '',
		bodyHtml: `<p>${name}</p>`,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...fields,
	};
}

async function insertReply(t: Harness, name: string, fields: Record<string, unknown>) {
	return t.run((ctx) => ctx.db.insert('mailSnippets', reply(name, fields) as never));
}

describe('saved replies', () => {
	it('erases personal replies, clears authorship on shared ones, keeps a colleague’s', async () => {
		const t = erasureHarness();
		const { organizationId, authUserId, requestId } = await seedEditor(t);
		const { mailboxId } = await seedPersonalMailbox(t, authUserId);
		const colleagueId = await seedIdentity(t, 'colleague@example.com');
		await seedMembership(t, organizationId, colleagueId, 'editor');

		const personal = await insertReply(t, 'mine', { scope: 'personal', ownerUserId: authUserId });
		const legacy = await insertReply(t, 'old', { mailboxId });
		const shared = await insertReply(t, 'team', {
			scope: 'shared',
			organizationId,
			authorUserId: authUserId,
		});
		const colleagues = await insertReply(t, 'theirs', {
			scope: 'personal',
			ownerUserId: colleagueId,
		});

		await runDeletionCron(t);
		await drainScheduled(t);
		expect((await requestOf(t, requestId))?.status).toBe('completed');

		await t.run(async (ctx) => {
			for (const gone of [personal, legacy] as Id<'mailSnippets'>[]) {
				expect(await ctx.db.get(gone), String(gone)).toBeNull();
			}
			const kept = await ctx.db.get(shared as Id<'mailSnippets'>);
			expect(kept).toMatchObject({ scope: 'shared', name: 'team' });
			expect(kept?.authorUserId).toBeUndefined();
			expect(await ctx.db.get(colleagues as Id<'mailSnippets'>)).not.toBeNull();
		});
	});
});
