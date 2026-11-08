/**
 * After a reply has gone out: one open task from the conversation is offered
 * by name, several by count with the first to review, none (or only finished
 * ones) offers nothing. A scheduled or offline-queued reply has not gone, and
 * a reply taken back ends its hold without the offer.
 */
import { describe, expect, it } from 'vitest';
import { createReplySendHolds, mailReplyWillLeave, replyTaskOffer } from '../replyTaskOffer';

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
	it('holds only a reply that leaves when its undo window closes', () => {
		expect(mailReplyWillLeave({ scheduled: false, queuedOffline: false })).toBe(true);
		expect(mailReplyWillLeave({ scheduled: true, queuedOffline: false })).toBe(false);
		expect(mailReplyWillLeave({ scheduled: false, queuedOffline: true })).toBe(false);
	});
});

describe('createReplySendHolds', () => {
	it('hands the hold back once when the reply goes out', () => {
		const holds = createReplySendHolds<string>();
		holds.hold('mail:t1', 'offer');
		expect(holds.release('mail:t1')).toBe('offer');
		expect(holds.release('mail:t1')).toBeNull();
	});

	it('drops a reply taken back, so its window closing offers nothing', () => {
		const holds = createReplySendHolds<string>();
		holds.hold('mail:t1', 'offer');
		holds.hold('mail:t2', 'other');
		holds.cancel('mail:t1');
		expect(holds.release('mail:t1')).toBeNull();
		expect(holds.has('mail:t2')).toBe(true);
	});
});
