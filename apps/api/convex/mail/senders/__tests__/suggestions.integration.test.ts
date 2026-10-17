/**
 * Suggestions are only offered when they are known (review r1, F1): a
 * never-read promotion the one-click budget cannot resolve is left out rather
 * than suggested as Auto-archive, ineligible profiles never spend the budget,
 * and applying applies only the action the person confirmed.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { api } from '../../../_generated/api';
import { modules, seedMessage } from '../../__tests__/helpers.testlib';
import { addSenderDelivery, emptySenderWeeks } from '../counters';
import { listSenderSuggestions } from '../suggestions';
import { profileOf, seedPersonalMailbox, seedProfile, type T } from './senders.testlib';

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

/** A never-read promotion sender whose newest mail offers one-click. */
async function seedPromo(
	t: T,
	mailboxId: Id<'mailboxes'>,
	address: string,
	lastDeliveredAt: number,
	extra: { statusSource?: 'user' } = {}
) {
	const now = Date.now();
	const weeks = addSenderDelivery(emptySenderWeeks(now), now);
	const profile = await seedProfile(t, mailboxId, {
		...weeks,
		address,
		kind: 'promotion',
		lastDeliveredAt,
		...extra,
	});
	const messageId = await seedMessage(t, mailboxId, { fromAddress: address, subject: address });
	await t.run(async (ctx) => {
		await ctx.db.patch(messageId, {
			unsubscribe: { oneClick: true, httpUrl: `https://${address.split('@')[1]}/u` },
		});
	});
	return profile;
}

describe('suggestions with a bounded one-click budget', () => {
	it('omits a promotion it cannot resolve, and skips ineligible profiles without spending', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		// Newest first in the scan: a promotion the person chose to keep.
		await seedPromo(t, mailboxId, 'kept@a.example', 300, { statusSource: 'user' });
		const first = await seedPromo(t, mailboxId, 'deals@b.example', 200);
		await seedPromo(t, mailboxId, 'deals@c.example', 100);

		const suggested = await t.run(async (ctx) =>
			listSenderSuggestions(ctx, mailboxId, Date.now(), 1)
		);
		expect(suggested.map((row) => [row.profile.address, row.suggestion])).toEqual([
			[first.address, 'unsubscribe'],
		]);
	});

	it('applies only the action the person confirmed', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId } = await seedPersonalMailbox(t);
		const promo = await seedPromo(t, mailboxId, 'deals@b.example', 200);
		const stale = await t.mutation(api.mail.senders.suggestions.applySuggestions, {
			mailboxId,
			items: [{ senderDigest: promo.senderDigest, suggestion: 'auto_archive' }],
		});
		expect(stale.applied).toBe(0);
		expect((await profileOf(t, mailboxId, promo.address))!.status).toBe('keep');

		const confirmed = await t.mutation(api.mail.senders.suggestions.applySuggestions, {
			mailboxId,
			items: [{ senderDigest: promo.senderDigest, suggestion: 'unsubscribe' }],
		});
		expect(confirmed.applied).toBe(1);
		expect((await profileOf(t, mailboxId, promo.address))!.status).toBe('unsubscribed');
	});
});
