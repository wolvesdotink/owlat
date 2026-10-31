/**
 * The approved-reply decisions (`agent/approvedReplyDecision.ts`) for plain
 * message snapshots. The action is held to them by
 * `__tests__/sendApprovedReply.characterization.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { Id } from '../../_generated/dataModel';
import {
	ATTACHMENT_WAIT_MS,
	MAX_ATTACHMENT_WAITS,
	planEmailReply,
	routeApprovedReply,
	settleIntakeOutcome,
	type ApprovedReplyMessage,
} from '../approvedReplyDecision';

const contactId = 'contact-1' as Id<'contacts'>;
const threadId = 'thread-1' as Id<'conversationThreads'>;
const sendId = 'send-1' as Id<'transactionalSends'>;

const message = (overrides: Partial<ApprovedReplyMessage> = {}): ApprovedReplyMessage => ({
	processingStatus: 'approved',
	draftResponse: 'Here is the help you asked for.',
	draftSubject: 'Re: Need help',
	subject: 'Need help',
	to: 'support@owlat.example',
	from: 'Customer <customer@example.com>',
	messageId: '<q-1@example.com>',
	references: undefined,
	threadId,
	contactId,
	...overrides,
});

const sender = { fromEmail: 'support@owlat.example', fromName: 'Owlat Support' };

describe('routeApprovedReply', () => {
	it('stops a file-copy wait once the message left approved, before anything else', () => {
		expect(
			routeApprovedReply(message({ processingStatus: 'draft_ready', draftResponse: '' }), 1)
		).toEqual({ kind: 'stop' });
		// The first try (no wait yet) does not look at the status.
		expect(routeApprovedReply(message({ processingStatus: 'draft_ready' }), 0)).toMatchObject({
			kind: 'email',
		});
	});

	it('fails without a draft', () => {
		expect(routeApprovedReply(message({ draftResponse: undefined }), 0)).toEqual({
			kind: 'fail',
			errorMessage: 'No draft to send',
		});
	});

	it('hands a channel reply to the adapter, or fails it without thread or contact', () => {
		expect(routeApprovedReply(message({ to: 'sms', draftSubject: undefined }), 0)).toEqual({
			kind: 'channel',
			dispatch: {
				channel: 'sms',
				contactId,
				threadId,
				content: { text: 'Here is the help you asked for.' },
			},
		});
		expect(routeApprovedReply(message({ to: 'generic', contactId: undefined }), 0)).toEqual({
			kind: 'fail',
			errorMessage: 'Channel reply (generic) is missing its thread or contact',
		});
	});

	it('replies by email to the parsed sender, or fails an unparseable one', () => {
		expect(routeApprovedReply(message(), 0)).toEqual({
			kind: 'email',
			recipient: 'customer@example.com',
			draft: 'Here is the help you asked for.',
		});
		expect(routeApprovedReply(message({ from: 'nobody' }), 0)).toEqual({
			kind: 'fail',
			errorMessage: 'Unsupported or invalid reply recipient: "nobody"',
		});
	});
});

describe('planEmailReply', () => {
	const route = { recipient: 'customer@example.com', draft: 'Here is the help you asked for.' };

	it('fails without a sending identity', () => {
		expect(planEmailReply(message(), route, { fromEmail: '' }, false)).toMatchObject({
			kind: 'fail',
			errorMessage: expect.stringMatching(/^No sending identity configured/),
		});
	});

	it('builds the envelope: derived subject, threading headers, named sender', () => {
		const plan = planEmailReply(message({ draftSubject: undefined }), route, sender, false);
		expect(plan).toMatchObject({
			kind: 'intake',
			envelope: {
				email: 'customer@example.com',
				contactId,
				subject: 'Re: Need help',
				draftText: route.draft,
				from: 'Owlat Support <support@owlat.example>',
				headers: { 'In-Reply-To': '<q-1@example.com>', References: '<q-1@example.com>' },
			},
		});
		expect(plan.kind === 'intake' && plan.envelope.html).toContain(route.draft);
	});

	it('leaves out empty headers, a missing contact and a missing name', () => {
		const plan = planEmailReply(
			message({ messageId: '', contactId: undefined, subject: '', draftSubject: undefined }),
			route,
			{ fromEmail: 'support@owlat.example' },
			false
		);
		expect(plan.kind === 'intake' && plan.envelope).toEqual({
			email: 'customer@example.com',
			subject: 'Re: your message',
			html: expect.any(String),
			draftText: route.draft,
			from: 'support@owlat.example',
		});
	});

	it('runs the reference monitor on the autonomous path only', () => {
		const leaking = { ...route, draft: 'Your key is AKIAABCDEFGHIJKLMNOP.' };
		expect(planEmailReply(message(), leaking, sender, true)).toMatchObject({
			kind: 'fail',
			errorMessage: expect.stringMatching(/^Reference monitor: .*aws_access_key_id/),
		});
		expect(planEmailReply(message(), leaking, sender, false).kind).toBe('intake');
	});

	it('gives the same plan for the same input', () => {
		expect(planEmailReply(message(), route, sender, true)).toEqual(
			planEmailReply(message(), route, sender, true)
		);
	});
});

describe('settleIntakeOutcome', () => {
	it('leaves an enqueued reply to the Send completion', () => {
		expect(settleIntakeOutcome({ ok: true, sendId, queued: true }, 0)).toEqual({
			kind: 'enqueued',
			sendId,
		});
	});

	it('waits for a copying file until the waits run out', () => {
		const copying = { ok: false as const, reason: 'attachment_copying' as const };
		expect(settleIntakeOutcome(copying, MAX_ATTACHMENT_WAITS - 1)).toEqual({
			kind: 'hold',
			attachmentWaits: MAX_ATTACHMENT_WAITS,
			delayMs: ATTACHMENT_WAIT_MS,
		});
		expect(settleIntakeOutcome(copying, MAX_ATTACHMENT_WAITS)).toEqual({
			kind: 'fail',
			errorMessage: 'A file for this reply is still being attached. Review and send it by hand.',
		});
	});

	it('fails a failed copy and a coverage or interpretation hold with its detail', () => {
		expect(settleIntakeOutcome({ ok: false, reason: 'attachment_failed' }, 0)).toEqual({
			kind: 'fail',
			errorMessage: 'A file for this reply could not be attached. Review and send it by hand.',
		});
		expect(
			settleIntakeOutcome({ ok: false, reason: 'item_coverage', detail: 'not covered' }, 0)
		).toEqual({ kind: 'fail', errorMessage: 'not covered' });
		expect(
			settleIntakeOutcome({ ok: false, reason: 'interpretation_incomplete', detail: 'stale' }, 0)
		).toEqual({ kind: 'fail', errorMessage: 'stale' });
	});

	it('archives a blocked recipient and fails a deployment refusal', () => {
		expect(settleIntakeOutcome({ ok: false, reason: 'recipient_blocked' }, 0)).toEqual({
			kind: 'archive',
			reason: 'sender_blocked',
			refusal: 'recipient_blocked',
		});
		expect(settleIntakeOutcome({ ok: false, reason: 'no_delivery_provider' }, 0)).toEqual({
			kind: 'fail',
			errorMessage: 'No delivery provider configured',
		});
		expect(
			settleIntakeOutcome({ ok: false, reason: 'no_delivery_provider', detail: 'Set it' }, 0)
		).toEqual({ kind: 'fail', errorMessage: 'Set it' });
		expect(settleIntakeOutcome({ ok: false, reason: 'abuse_blocked' }, 0)).toEqual({
			kind: 'fail',
			errorMessage: 'Sending is disabled while this instance is suspended.',
		});
	});
});
