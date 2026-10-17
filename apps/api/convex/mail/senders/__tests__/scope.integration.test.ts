/**
 * Senders is personal-only (review r1, F5): a mailbox that becomes a team
 * inbox between a decision and its late write gets neither. A scheduled
 * suggestion settlement archives nothing, and opening mail counted while the
 * mailbox was personal does not move the counters.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { api } from '../../../_generated/api';
import { modules } from '../../__tests__/helpers.testlib';
import { deliverHosted, profileOf, roleOf, seedPersonalMailbox, type T } from './senders.testlib';
import { addSenderDelivery, emptySenderWeeks } from '../counters';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner' as const, activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

/** The scope flip alone, without the drain a real conversion schedules. */
async function makeShared(t: T, mailboxId: Id<'mailboxes'>) {
	await t.run(async (ctx) => await ctx.db.patch(mailboxId, { scope: 'shared' }));
}

const sum = (weeks: number[]) => weeks.reduce((total, n) => total + n, 0);

describe('a mailbox that became a team inbox', () => {
	it('gets no archive from a suggestion settled after the conversion', async () => {
		vi.useFakeTimers();
		try {
			const t = convexTest(schema, modules);
			const { mailboxId } = await seedPersonalMailbox(t);
			const id = (await deliverHosted(t))!;
			const profile = (await profileOf(t, mailboxId))!;
			await t.run(async (ctx) => {
				const now = Date.now();
				let weeks = emptySenderWeeks(now);
				for (let i = 0; i < 5; i++) weeks = addSenderDelivery(weeks, now);
				await ctx.db.patch(profile._id, { ...weeks, kind: 'promotion' });
			});
			const applied = await t.mutation(api.mail.senders.suggestions.applySuggestions, {
				mailboxId,
				items: [{ senderDigest: profile.senderDigest, suggestion: 'auto_archive' }],
			});
			expect(applied.applied).toBe(1);

			await makeShared(t, mailboxId);
			await t.finishAllScheduledFunctions(vi.runAllTimers);
			expect(await roleOf(t, id)).toBe('inbox');
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not count an open of mail counted before the conversion', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const id = (await deliverHosted(t))!;
		await makeShared(t, mailboxId);
		await t.mutation(api.mail.senders.opens.markOpened, { messageId: id });
		expect(sum((await profileOf(t, mailboxId))!.openedWeeks)).toBe(0);
	});
});
