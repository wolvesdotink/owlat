import { describe, it, expect } from 'vitest';
import {
	isSenderTab,
	senderName,
	senderReadPercent,
	suggestedStatus,
	unsubscribeResultKey,
} from '../postboxSenders';

describe('postboxSenders', () => {
	it('knows its tabs', () => {
		expect(isSenderTab('review')).toBe(true);
		expect(isSenderTab('auto_archive')).toBe(true);
		expect(isSenderTab('blocked')).toBe(false);
		expect(isSenderTab(undefined)).toBe(false);
	});

	it('draws the read bar from opened ÷ delivered', () => {
		expect(senderReadPercent({ delivered: 0, opened: 0 })).toBe(0);
		expect(senderReadPercent({ delivered: 38, opened: 2 })).toBe(5);
		expect(senderReadPercent({ delivered: 9, opened: 8 })).toBe(89);
		expect(senderReadPercent({ delivered: 2, opened: 3 })).toBe(100);
	});

	it('maps a suggestion to the status it sets', () => {
		expect(suggestedStatus('unsubscribe')).toBe('unsubscribed');
		expect(suggestedStatus('digest')).toBe('digest');
		expect(suggestedStatus('auto_archive')).toBe('auto_archive');
	});

	it('describes an unsubscribe result only for an unsubscribed sender', () => {
		const unsubscribe = { method: 'one_click' as const, requestedAt: 1, result: 'failed' as const };
		expect(unsubscribeResultKey({ status: 'unsubscribed', unsubscribe })).toBe(
			'postbox.senders.result.failed'
		);
		expect(unsubscribeResultKey({ status: 'keep', unsubscribe })).toBeNull();
		expect(unsubscribeResultKey({ status: 'unsubscribed' })).toBeNull();
	});

	it('names a sender by display name, else address', () => {
		expect(senderName({ displayName: 'Manufactum', address: 'newsletter@m.example' })).toBe(
			'Manufactum'
		);
		expect(senderName({ address: 'newsletter@m.example' })).toBe('newsletter@m.example');
	});
});
