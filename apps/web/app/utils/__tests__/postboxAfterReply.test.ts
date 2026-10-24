import { describe, expect, it } from 'vitest';
import {
	POSTBOX_AFTER_REPLY_DEFAULT,
	POSTBOX_AFTER_REPLY_OPTIONS,
	afterReplyFor,
	oppositeAfterReply,
	resolvePostboxAfterReply,
} from '../postboxAfterReply';

describe('postboxAfterReply', () => {
	it('defaults to keeping the conversation, the behaviour before the setting', () => {
		expect(POSTBOX_AFTER_REPLY_DEFAULT).toBe('keep');
		expect(resolvePostboxAfterReply(undefined)).toBe('keep');
		expect(resolvePostboxAfterReply('archive')).toBe('keep');
		expect(resolvePostboxAfterReply('done')).toBe('done');
		expect(POSTBOX_AFTER_REPLY_OPTIONS.map((o) => o.value)).toEqual(['keep', 'done']);
	});

	it('flips the setting for the opposite chord and honours an explicit choice', () => {
		expect(oppositeAfterReply('keep')).toBe('done');
		expect(oppositeAfterReply('done')).toBe('keep');
		expect(afterReplyFor('keep')).toBe('keep');
		expect(afterReplyFor('done')).toBe('done');
		expect(afterReplyFor('keep', 'opposite')).toBe('done');
		expect(afterReplyFor('done', 'opposite')).toBe('keep');
		expect(afterReplyFor('done', 'keep')).toBe('keep');
		expect(afterReplyFor('keep', 'done')).toBe('done');
	});
});
