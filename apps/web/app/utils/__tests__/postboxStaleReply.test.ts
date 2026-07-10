import { describe, it, expect } from 'vitest';
import { isReplyStale, type ReplyStateSnapshot } from '../postboxStaleReply';

const snap = (messageId: string | null, byIsYou = false): ReplyStateSnapshot => ({
	messageId,
	byIsYou,
});

describe('isReplyStale', () => {
	it('is not stale when nothing changed since the composer opened', () => {
		const opened = snap('r1');
		expect(isReplyStale(opened, snap('r1'))).toBe(false);
	});

	it('is stale when a different teammate replied after opening', () => {
		const opened = snap('r1');
		expect(isReplyStale(opened, snap('r2'))).toBe(true);
	});

	it('is stale when the first reply arrives on a thread that had none at open', () => {
		const opened = snap(null);
		expect(isReplyStale(opened, snap('r1'))).toBe(true);
	});

	it('is never stale for the current user’s own latest reply', () => {
		const opened = snap('r1');
		expect(isReplyStale(opened, snap('r2', true))).toBe(false);
	});

	it('is never stale when there is no live reply state (personal mailbox / no replies)', () => {
		expect(isReplyStale(snap('r1'), null)).toBe(false);
		expect(isReplyStale(null, null)).toBe(false);
		expect(isReplyStale(snap('r1'), snap(null))).toBe(false);
	});

	it('treats a missing opened snapshot as no prior reply', () => {
		expect(isReplyStale(null, snap('r1'))).toBe(true);
	});
});
