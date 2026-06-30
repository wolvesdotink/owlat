import { describe, it, expect } from 'vitest';
import { resolveNotificationEffect } from '../notificationActions.client';

describe('resolveNotificationEffect', () => {
	it('routes a click (open) to the thread', () => {
		expect(
			resolveNotificationEffect({ action: 'open', messageId: 'm1', folderRole: 'inbox' })
		).toEqual({ type: 'open', folderRole: 'inbox', messageId: 'm1' });
	});

	it('routes the Archive action', () => {
		expect(resolveNotificationEffect({ action: 'archive', messageId: 'm1' })).toEqual({
			type: 'archive',
			messageId: 'm1',
		});
	});

	it('defaults folderRole to inbox and treats unknown actions as open', () => {
		expect(resolveNotificationEffect({ action: 'whatever', messageId: 'm1' })).toEqual({
			type: 'open',
			folderRole: 'inbox',
			messageId: 'm1',
		});
	});

	it('returns null without a messageId or for malformed payloads', () => {
		expect(resolveNotificationEffect({ action: 'open' })).toBeNull();
		expect(resolveNotificationEffect({})).toBeNull();
		expect(resolveNotificationEffect({ action: 'archive', messageId: 123 })).toBeNull();
	});
});
