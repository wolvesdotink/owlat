import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

const modules = import.meta.glob('../**/*.*s');

/**
 * Guards the range-scan fix in mail/outboundCron.ts: findOverdueDrafts reads
 * only the overdue tail of the `pending_send` / `scheduled` partitions via the
 * compound index range (state eq + scheduledSendAt <= cutoff), and signals
 * `full` when the batch saturates so the action self-reschedules to drain.
 */
describe('mail/outboundCron.findOverdueDrafts', () => {
	async function seedMailbox(t: ReturnType<typeof convexTest>) {
		return t.run(async (ctx) => {
			const now = Date.now();
			return ctx.db.insert('mailboxes', {
				userId: 'user-1',
				organizationId: 'org-1',
				address: 'alice@example.com',
				domain: 'example.com',
				status: 'active' as const,
				usedBytes: 0,
				uidValidity: now,
				createdAt: now,
				updatedAt: now,
			});
		});
	}

	const baseDraft = (
		mailboxId: Id<'mailboxes'>,
		overrides: {
			state: 'draft' | 'pending_send' | 'scheduled';
			scheduledSendAt?: number;
			undoToken?: string;
		},
	) => {
		const now = Date.now();
		return {
			mailboxId,
			toAddresses: ['bob@example.com'],
			ccAddresses: [],
			bccAddresses: [],
			fromAddress: 'alice@example.com',
			subject: 'Hi',
			bodyHtml: '<p>Hi</p>',
			attachments: [],
			lastEditedAt: now,
			createdAt: now,
			...overrides,
		};
	};

	it('picks overdue drafts in both states, skipping future and non-overdue ones', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const mailboxId = await seedMailbox(t);

		const expectedIds = await t.run(async (ctx) => {
			const overduePending = await ctx.db.insert(
				'mailDrafts',
				baseDraft(mailboxId, {
					state: 'pending_send',
					scheduledSendAt: now - 60_000, // well overdue
					undoToken: 'tok-pending',
				}),
			);
			const overdueScheduled = await ctx.db.insert(
				'mailDrafts',
				baseDraft(mailboxId, {
					state: 'scheduled',
					scheduledSendAt: now - 30_000, // overdue
					undoToken: 'tok-scheduled',
				}),
			);
			// Future-scheduled — must NOT be picked.
			await ctx.db.insert(
				'mailDrafts',
				baseDraft(mailboxId, {
					state: 'scheduled',
					scheduledSendAt: now + 600_000,
					undoToken: 'tok-future',
				}),
			);
			// Just-now (inside the 5s staleness threshold) — must NOT be picked.
			await ctx.db.insert(
				'mailDrafts',
				baseDraft(mailboxId, {
					state: 'pending_send',
					scheduledSendAt: now,
					undoToken: 'tok-fresh',
				}),
			);
			// Plain draft (not in a send state) — must NOT be picked.
			await ctx.db.insert('mailDrafts', baseDraft(mailboxId, { state: 'draft' }));
			return [overduePending as string, overdueScheduled as string];
		});

		const result = await t.mutation(internal.mail.outboundCron.findOverdueDrafts, {});

		expect(result.items).toHaveLength(2);
		expect(new Set(result.items.map((i) => i.draftId))).toEqual(new Set(expectedIds));
		expect(result.items.every((i) => typeof i.undoToken === 'string')).toBe(true);
		expect(result.full).toBe(false);
	});

	it('flags full when a single state saturates the batch', async () => {
		const t = convexTest(schema, modules);
		const now = Date.now();
		const mailboxId = await seedMailbox(t);

		await t.run(async (ctx) => {
			// 50 = BATCH_SIZE overdue scheduled drafts.
			for (let i = 0; i < 50; i++) {
				await ctx.db.insert(
					'mailDrafts',
					baseDraft(mailboxId, {
						state: 'scheduled',
						scheduledSendAt: now - 60_000 - i,
						undoToken: `tok-${i}`,
					}),
				);
			}
		});

		const result = await t.mutation(internal.mail.outboundCron.findOverdueDrafts, {});
		expect(result.items).toHaveLength(50);
		expect(result.full).toBe(true);
	});
});
