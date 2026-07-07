import { describe, it, expect } from 'vitest';
import {
	isReplyCollision,
	replyCollisionToast,
	sendHoldReason,
	GENERIC_TEAMMATE_NAME,
} from '../replyCollision';

describe('replyCollision copy', () => {
	it('sendHoldReason names the teammate and promises auto-release', () => {
		expect(sendHoldReason('Jordan')).toBe(
			'held while Jordan is editing — takes over automatically if they leave'
		);
	});

	it('replyCollisionToast names the teammate and points at the thread', () => {
		expect(replyCollisionToast('Jordan')).toBe('Jordan just sent a reply — review the thread');
	});
});

describe('isReplyCollision', () => {
	it('narrows the collision soft-error shape', () => {
		expect(isReplyCollision({ success: false, reason: 'reply_in_progress' })).toBe(true);
		expect(
			isReplyCollision({ success: false, reason: 'reply_in_progress', heldByName: 'Amir' })
		).toBe(true);
	});

	it('rejects success results and unrelated values', () => {
		expect(isReplyCollision({ success: true })).toBe(false);
		expect(isReplyCollision({ success: false, reason: 'something_else' })).toBe(false);
		expect(isReplyCollision(undefined)).toBe(false);
		expect(isReplyCollision(null)).toBe(false);
	});

	it('exposes a human fallback name', () => {
		expect(GENERIC_TEAMMATE_NAME).toBe('A teammate');
	});
});
