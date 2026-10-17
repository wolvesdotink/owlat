/**
 * The calm reader's one notice slot (read on arrival §3): one banner per
 * thread, danger > key change > left draft > image consent.
 */
import { describe, expect, it } from 'vitest';
import { pickReaderNotice, readerDangerOf } from '../postboxReaderNotice';

describe('pickReaderNotice', () => {
	it('shows exactly one banner, in priority order', () => {
		const all = { danger: true, keyChange: true, leftDraft: true, images: true };
		expect(pickReaderNotice(all)).toBe('danger');
		expect(pickReaderNotice({ ...all, danger: false })).toBe('keyChange');
		expect(pickReaderNotice({ ...all, danger: false, keyChange: false })).toBe('leftDraft');
		expect(pickReaderNotice({ images: true })).toBe('images');
		expect(pickReaderNotice({})).toBeNull();
	});

	it('hands the slot to the next one once the one above resolves', () => {
		expect(pickReaderNotice({ keyChange: false, leftDraft: true, images: true })).toBe('leftDraft');
		expect(pickReaderNotice({ keyChange: true, images: true })).toBe('keyChange');
	});
});

describe('readerDangerOf', () => {
	const from = 'lena@studio.example';

	it('names spam first, then a sender check that resolved to failed', () => {
		expect(readerDangerOf({ fromAddress: from, spamVerdict: 'spam', dmarcResult: 'fail' })).toBe(
			'spam'
		);
		expect(readerDangerOf({ fromAddress: from, dmarcResult: 'fail' })).toBe('dmarc');
		expect(
			readerDangerOf({ fromAddress: from, spamVerdict: 'ham', dmarcResult: 'pass' })
		).toBeNull();
		expect(readerDangerOf(undefined)).toBeNull();
	});

	it('is not danger when a trusted forwarder rescued the DMARC failure (ARC)', () => {
		expect(
			readerDangerOf({
				fromAddress: from,
				dmarcResult: 'fail',
				dmarcOverride: 'arc',
				arcSealer: 'lists.example',
			})
		).toBeNull();
		// Spam stays danger whatever the authentication says.
		expect(
			readerDangerOf({
				fromAddress: from,
				spamVerdict: 'spam',
				dmarcResult: 'fail',
				dmarcOverride: 'arc',
			})
		).toBe('spam');
	});
});
