/**
 * Activity writers (SPEC §5): the housekeeping hooks in the Postbox and team
 * mutations, the send hooks, files on a reply and bookings append one
 * recorded row each, with a stable key, so a repeat does not double it.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import type { Id } from '../../../_generated/dataModel';
import type { ThreadRef } from '../../../lib/validators/threadRef';
import { holdApprovedSend } from '../../../inbox/processingLifecycle/autoSendCancel';
import { recordPostboxSendQueued } from '../sendActivity';
import { recordBooked, recordClarificationAnswered } from '../threadEvents';
import {
	modules,
	reduceItem,
	reduceResult,
	seedMailThread,
	seedTeamThread,
	type Test,
} from './interpret.testlib';

vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../../lib/sessionOrganization');
	const session = { userId: 'user-A', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn(async () => session),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => session),
		requireAdminContext: vi.fn(async () => session),
		getBetterAuthSessionWithRole: vi.fn(async () => session),
	};
});

async function activityOf(t: Test, ref: ThreadRef) {
	return t.run(async (ctx) =>
		ref.kind === 'mail'
			? ctx.db
					.query('threadActivity')
					.withIndex('by_mail_thread_and_seq', (q) => q.eq('mailThreadId', ref.id))
					.collect()
			: ctx.db
					.query('threadActivity')
					.withIndex('by_conversation_thread_and_seq', (q) => q.eq('conversationThreadId', ref.id))
					.collect()
	);
}

describe('Postbox housekeeping', () => {
	it('snooze, label and mute each append one housekeeping row; a repeat appends none', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, messageId, threadId } = await seedMailThread(t);
		const labelId = await t.run(async (ctx) =>
			ctx.db.insert('mailLabels', { mailboxId, name: 'Clients', createdAt: Date.now() })
		);
		const until = Date.now() + 86_400_000;

		await t.mutation(api.mail.snooze.snoozeThread, { threadId, until });
		await t.mutation(api.mail.snooze.snoozeThread, { threadId, until });
		await t.mutation(api.mail.labels.toggleOnThread, { threadId, labelId, add: true });
		// Already labelled: no change, no row.
		await t.mutation(api.mail.labels.toggleOnThread, { threadId, labelId, add: true });
		await t.mutation(api.mail.mute.setMutedForMessage, { messageId, muted: true });

		const rows = await activityOf(t, { kind: 'mail', id: threadId });
		expect(rows.map((r) => [r.type, r.visibility, r.actor])).toEqual([
			['snoozed', 'housekeeping', { kind: 'user', id: 'user-A' }],
			['labelled', 'housekeeping', { kind: 'user', id: 'user-A' }],
			['muted', 'housekeeping', { kind: 'user', id: 'user-A' }],
		]);
		expect(rows.every((r) => r.provenance === 'recorded')).toBe(true);
	});

	it('a reply sent into its undo window appends send_queued once per send', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedMailThread(t);
		const draftId = await t.run(async (ctx) =>
			ctx.db.insert('mailDrafts', {
				mailboxId,
				threadId,
				toAddresses: ['jonas@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				fromAddress: 'me@owlat.test',
				subject: 'Re: hello',
				bodyHtml: '',
				attachments: [],
				state: 'draft',
				lastEditedAt: Date.now(),
				createdAt: Date.now(),
			})
		);

		await t.run(async (ctx) => {
			const draft = (await ctx.db.get(draftId))!;
			const args = { userId: 'user-A', undoToken: 'tok-1', sendAt: 1, isScheduled: false };
			await recordPostboxSendQueued(ctx, draft, args);
			await recordPostboxSendQueued(ctx, draft, args);
			// A send after an undo is a new event.
			await recordPostboxSendQueued(ctx, draft, { ...args, undoToken: 'tok-2' });
		});

		const rows = await activityOf(t, { kind: 'mail', id: threadId });
		expect(rows.map((r) => [r.type, r.visibility])).toEqual([
			['send_queued', 'substance'],
			['send_queued', 'substance'],
		]);
	});
});

describe('Team housekeeping and sends', () => {
	it('unassigning and snoozing a team thread append housekeeping rows', async () => {
		const t = convexTest(schema, modules);
		const { threadId } = await seedTeamThread(t, { assignedTo: 'user-B' });

		await t.mutation(api.inbox.mutations.assignThread, { threadId });
		await t.mutation(api.inbox.snooze.snoozeThread, { threadId, until: Date.now() + 60_000 });

		const rows = await activityOf(t, { kind: 'team', id: threadId });
		expect(rows.map((r) => [r.type, r.visibility, r.actor.id])).toEqual([
			['assigned', 'housekeeping', 'user-A'],
			['snoozed', 'housekeeping', 'user-A'],
		]);
	});

	it('a held send appends send_held once per wait', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(inboundId, { processingStatus: 'approved' });
			const hold = { autonomous: true, attachmentWaits: 1, delayMs: 5_000 };
			await holdApprovedSend(ctx, (await ctx.db.get(inboundId))!, hold);
			await holdApprovedSend(ctx, (await ctx.db.get(inboundId))!, hold);
		});

		const rows = await activityOf(t, { kind: 'team', id: threadId });
		expect(rows.map((r) => [r.type, r.actor.kind])).toEqual([['send_held', 'system']]);
	});

	it('an approval that schedules the send appends send_queued', async () => {
		const t = convexTest(schema, modules);
		const { threadId, inboundId } = await seedTeamThread(t);
		await t.run(async (ctx) => {
			await ctx.db.patch(inboundId, {
				processingStatus: 'draft_ready',
				draftResponse: 'Your refund is on its way.',
			});
		});

		await t.mutation(internal.inbox.processingLifecycle.transition, {
			inboundMessageId: inboundId,
			input: { to: 'approved', at: Date.now(), source: 'auto' },
		});

		const rows = await activityOf(t, { kind: 'team', id: threadId });
		expect(rows.map((r) => [r.type, r.actor.kind])).toEqual([['send_queued', 'agent']]);
	});
});

describe('clarification answered and bookings', () => {
	it('a clarification answer row names its one item', async () => {
		const t = convexTest(schema, modules);
		const { mailboxId, threadId } = await seedMailThread(t);
		const ref: ThreadRef = { kind: 'mail', id: threadId };
		const itemId = await t.run(async (ctx) => {
			const now = Date.now();
			const text = 'Which bay?';
			return ctx.db.insert('threadItems', {
				threadKind: 'mail',
				mailThreadId: threadId,
				mailboxId,
				revision: 1,
				intent: 'question',
				facets: [],
				assertion: text,
				display: { en: text, de: text },
				requester: { email: 'jonas@example.com', isUs: false },
				responsible: { isUs: true },
				responsibility: 'us',
				status: 'open',
				disposition: 'unanswered',
				evidence: [],
				verify: 'na',
				askedAt: now,
				createdAt: now,
				updatedAt: now,
			});
		});

		await t.run(async (ctx) => {
			const args = {
				userId: 'user-A',
				clarificationKey: `${threadId}:1`,
				questions: [{ itemId, answer: { value: 'Bay 3' } }, { answer: { value: 'Monday' } }],
			};
			await recordClarificationAnswered(ctx, ref, args);
			await recordClarificationAnswered(ctx, ref, args);
		});

		const rows = await activityOf(t, ref);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ type: 'clarification_answered', itemId });
	});

	it("a booking lands on the thread of the guest's open meeting item, and only there", async () => {
		const t = convexTest(schema, modules);
		const { messageId, threadId } = await seedMailThread(t);
		await t.mutation(internal.mail.interpret.reduce.applyInterpretation, {
			source: { kind: 'mail', id: messageId },
			threadRef: { kind: 'mail', id: threadId },
			mode: 'brief',
			contentRevision: 'rev-1',
			extractorVersion: 1,
			expectedRevision: 0,
			deletionEpoch: 0,
			sourceAt: Date.now(),
			direction: 'inbound',
			status: 'complete',
			result: reduceResult({ items: [reduceItem({ intent: 'request', facets: ['meeting'] })] }),
		});
		const bookingId = 'booking-1' as Id<'bookings'>;

		await t.run(async (ctx) => {
			const booking = {
				userId: 'user-A',
				guestEmail: 'Jonas@Example.com',
				startAt: 1,
				title: 'Call',
			};
			await recordBooked(ctx, bookingId, booking);
			await recordBooked(ctx, bookingId, booking);
			// Another host's booking with the same guest is not this thread's.
			await recordBooked(ctx, 'booking-2' as Id<'bookings'>, { ...booking, userId: 'user-B' });
		});

		const booked = (await activityOf(t, { kind: 'mail', id: threadId })).filter(
			(r) => r.type === 'booked'
		);
		expect(booked).toHaveLength(1);
		expect(booked[0]).toMatchObject({
			actor: { kind: 'sender' },
			opRef: { kind: 'booking', id: bookingId },
		});
	});
});
