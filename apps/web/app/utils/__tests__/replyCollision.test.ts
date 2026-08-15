import { describe, it, expect } from 'vitest';
import {
	isReplyCollision,
	replyCollisionToast,
	sendHoldReason,
	GENERIC_TEAMMATE_NAME,
	type ReplyCollisionMessage,
} from '../replyCollision';
import { createTestI18n } from '~/__tests__/i18n';

// The copy helpers are pure, so they hand back a message key plus the name it
// interpolates; the sentence a person reads comes from the real catalog.
const { t } = createTestI18n().global;
const message = (value: ReplyCollisionMessage) => t(value.key, value.params ?? {});

describe('replyCollision copy', () => {
	it('sendHoldReason names the teammate and promises auto-release', () => {
		expect(message(sendHoldReason('Jordan'))).toBe(
			'held while Jordan is editing — takes over automatically if they leave'
		);
	});

	it('replyCollisionToast names the teammate and points at the thread', () => {
		expect(message(replyCollisionToast('Jordan'))).toBe(
			'Jordan just sent a reply — review the thread'
		);
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
		expect(t(GENERIC_TEAMMATE_NAME)).toBe('A teammate');
	});
});
