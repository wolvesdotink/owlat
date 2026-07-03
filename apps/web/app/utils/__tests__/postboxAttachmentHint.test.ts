import { describe, it, expect } from 'vitest';
import { mentionsAttachment } from '../postboxAttachmentHint';

describe('mentionsAttachment', () => {
	it('flags prose that says "attached"', () => {
		expect(mentionsAttachment('Report', '<p>See the attached file.</p>')).toBe(true);
	});

	it('flags "enclosed" and other attach-word variants in the subject', () => {
		expect(mentionsAttachment('Docs enclosed', '<p>Hi</p>')).toBe(true);
		expect(mentionsAttachment('', '<p>attaching the deck</p>')).toBe(true);
	});

	it('does not match HTML tag/attribute text (tags are stripped first)', () => {
		expect(mentionsAttachment('', '<a href="/enclosed-path">link</a>')).toBe(false);
	});

	it('returns false when nothing hints at an attachment', () => {
		expect(mentionsAttachment('Lunch?', '<p>Free at noon</p>')).toBe(false);
	});
});
