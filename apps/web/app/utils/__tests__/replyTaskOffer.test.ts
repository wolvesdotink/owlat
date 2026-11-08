/**
 * After a reply has gone out: one open task from the conversation is offered
 * by name, several by count with the first to review, none (or only finished
 * ones) offers nothing. A scheduled or offline-queued reply is not watched,
 * and a held reply counts as sent only on the server's record of a send that
 * reached its recipients.
 */
import { describe, expect, it } from 'vitest';
import {
	followUpStatus,
	mailReplyStatus,
	mailReplyWillLeave,
	outboundBaseline,
	replyTaskOffer,
	teamReplyStatus,
} from '../replyTaskOffer';

const task = (id: string, status: 'open' | 'done' | 'dropped' = 'open') => ({
	_id: id,
	title: `Task ${id}`,
	status,
});

describe('replyTaskOffer', () => {
	it('offers nothing without an open task', () => {
		expect(replyTaskOffer(undefined)).toBeNull();
		expect(replyTaskOffer([])).toBeNull();
		expect(replyTaskOffer([task('a', 'done'), task('b', 'dropped')])).toBeNull();
	});

	it('names the one open task, whatever else is finished', () => {
		const open = task('b');
		expect(replyTaskOffer([open, task('a', 'done')])).toEqual({ kind: 'one', task: open });
	});

	it('counts several open tasks and leads with the first', () => {
		const first = task('a');
		expect(replyTaskOffer([first, task('b'), task('c'), task('d', 'done')])).toEqual({
			kind: 'several',
			count: 3,
			first,
		});
	});
});

describe('mailReplyWillLeave', () => {
	it('watches only a reply that leaves on its own', () => {
		expect(mailReplyWillLeave({ scheduled: false, queuedOffline: false })).toBe(true);
		expect(mailReplyWillLeave({ scheduled: true, queuedOffline: false })).toBe(false);
		expect(mailReplyWillLeave({ scheduled: false, queuedOffline: true })).toBe(false);
	});
});

const row = (messageId: string, state: string, recipients = [state]) => ({
	messageId,
	state,
	recipients: recipients.map((r) => ({ state: r })),
});

describe('mailReplyStatus', () => {
	const baseline = ['m_old'];

	it('waits while the draft is held in its undo window', () => {
		expect(mailReplyStatus({ draft: undefined, baseline: null, delivery: undefined })).toBe(
			'waiting'
		);
		expect(
			mailReplyStatus({
				draft: { state: 'pending_send' },
				baseline,
				delivery: [row('m_old', 'sent')],
			})
		).toBe('waiting');
	});

	it('fails a draft put back: an Undo, or a dispatch the server refused', () => {
		expect(mailReplyStatus({ draft: { state: 'draft' }, baseline, delivery: [] })).toBe('failed');
	});

	it('waits for the filed message until every recipient took it, then counts it sent', () => {
		const filed = (state: string, recipients?: string[]) =>
			mailReplyStatus({
				draft: null,
				baseline,
				delivery: [row('m_old', 'sent'), row('m_new', state, recipients)],
			});
		expect(mailReplyStatus({ draft: null, baseline, delivery: [row('m_old', 'sent')] })).toBe(
			'waiting'
		);
		expect(filed('queued')).toBe('waiting');
		expect(filed('partial', ['sent', 'queued'])).toBe('waiting');
		expect(filed('sent')).toBe('sent');
	});

	it('fails a filed message the transport refused for anyone', () => {
		const filed = (state: string, recipients?: string[]) =>
			mailReplyStatus({ draft: null, baseline, delivery: [row('m_new', state, recipients)] });
		expect(filed('failed')).toBe('failed');
		expect(filed('bounced')).toBe('failed');
		expect(filed('partial', ['sent', 'failed'])).toBe('failed');
	});

	it('offers nothing when it cannot tell which sent message is the reply', () => {
		expect(mailReplyStatus({ draft: null, baseline: null, delivery: [row('m_new', 'sent')] })).toBe(
			'failed'
		);
		expect(mailReplyStatus({ draft: null, baseline, delivery: null })).toBe('failed');
	});

	it('takes its baseline from the rows seen beside the held draft', () => {
		expect(outboundBaseline([row('m_old', 'sent')])).toEqual(['m_old']);
		expect(outboundBaseline(undefined)).toBeNull();
	});
});

describe('teamReplyStatus', () => {
	const at = (processingStatus: string) => [{ _id: 'in_1', processingStatus }];

	it('waits while approved, and counts the Send reaching sent', () => {
		expect(teamReplyStatus(undefined, 'in_1')).toBe('waiting');
		expect(teamReplyStatus(at('approved'), 'in_1')).toBe('waiting');
		expect(teamReplyStatus(at('sent'), 'in_1')).toBe('sent');
	});

	it('fails an approve that was undone, a Send that failed, or a message gone', () => {
		expect(teamReplyStatus(at('draft_ready'), 'in_1')).toBe('failed');
		expect(teamReplyStatus(at('failed'), 'in_1')).toBe('failed');
		expect(teamReplyStatus([], 'in_1')).toBe('failed');
	});
});

describe('followUpStatus', () => {
	const at = (status: string) => [{ _id: 'fu_1', status }];

	it('waits through its window and its Send, and counts it sent', () => {
		expect(followUpStatus(undefined, 'fu_1')).toBe('waiting');
		expect(followUpStatus(at('scheduled'), 'fu_1')).toBe('waiting');
		expect(followUpStatus(at('sending'), 'fu_1')).toBe('waiting');
		expect(followUpStatus(at('sent'), 'fu_1')).toBe('sent');
	});

	it('fails a refused dispatch, a failed Send, or an undone follow-up', () => {
		expect(followUpStatus(at('failed'), 'fu_1')).toBe('failed');
		expect(followUpStatus([], 'fu_1')).toBe('failed');
	});
});
