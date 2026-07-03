/**
 * "Forgot the attachment?" detection (utils/attachmentMention).
 */
import { describe, it, expect } from 'vitest';
import { mentionsAttachment } from '../attachmentMention';

describe('mentionsAttachment', () => {
	it('matches attach/enclosed word variants in the subject or body', () => {
		expect(mentionsAttachment('See attached', '')).toBe(true);
		expect(mentionsAttachment('', 'the file is enclosed below')).toBe(true);
		expect(mentionsAttachment('', 'I am attaching the report')).toBe(true);
	});
	it('strips HTML tags before matching so tag names never count', () => {
		expect(mentionsAttachment('', '<p>please find it attached</p>')).toBe(true);
		expect(mentionsAttachment('', '<attachment>x</attachment>')).toBe(false);
	});
	it('does not match unrelated copy', () => {
		expect(mentionsAttachment('Weekly sync', '<p>Notes from today.</p>')).toBe(false);
	});
});
