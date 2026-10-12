/**
 * The one table both readers use for the attachment-indexing marker.
 */
import { describe, expect, it } from 'vitest';
import { notIndexedNoticeKey } from '../attachmentIndexing';

describe('notIndexedNoticeKey', () => {
	it('has no line for indexed files or an unmarked message', () => {
		expect(notIndexedNoticeKey('indexed')).toBeNull();
		expect(notIndexedNoticeKey(undefined)).toBeNull();
	});

	it('maps the attachment-gate markers (L6) to their sentences', () => {
		expect(notIndexedNoticeKey('skipped_spam')).toBe(
			'components.inbox.inboxMessageAttachments.notIndexedSpam'
		);
		expect(notIndexedNoticeKey('skipped_automated')).toBe(
			'components.inbox.inboxMessageAttachments.notIndexedAutomated'
		);
		expect(notIndexedNoticeKey('skipped_unscanned')).toBe(
			'components.inbox.inboxMessageAttachments.notScanned'
		);
	});
});
