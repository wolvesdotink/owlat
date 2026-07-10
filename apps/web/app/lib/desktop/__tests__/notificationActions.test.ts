import { describe, it, expect, vi } from 'vitest';
import type { ConvexClient } from 'convex/browser';
import { replyFromNotification, resolveNotificationEffect } from '../notificationActions.client';

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

	it('routes a reply with typed text', () => {
		expect(
			resolveNotificationEffect({ action: 'reply', messageId: 'm1', reply: 'on it, thanks' })
		).toEqual({ type: 'reply', messageId: 'm1', text: 'on it, thanks' });
	});

	it('treats an empty reply as an open (no blank message)', () => {
		expect(resolveNotificationEffect({ action: 'reply', messageId: 'm1', reply: '' })).toEqual({
			type: 'open',
			folderRole: 'inbox',
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

describe('replyFromNotification', () => {
	it('sends via the draft pipeline on the happy path and never opens the composer', async () => {
		const mutation = vi.fn(async () => ({ draftId: 'd1' }));
		const query = vi.fn(async () => ({
			mailboxId: 'mb1',
			fromAddress: 'sender@example.com',
			subject: 'Hello',
		}));
		const openComposer = vi.fn(async () => {});
		const convex = { query, mutation } as unknown as ConvexClient;

		await replyFromNotification(convex, 'm1', 'Sounds good', { openComposer });

		// create → update → send == three mutations, all through the existing path.
		expect(mutation).toHaveBeenCalledTimes(3);
		expect(openComposer).not.toHaveBeenCalled();
	});

	it('opens the composer prefilled with the typed text when the send fails', async () => {
		// getMessage succeeds (so we can seed to/subject), but create throws.
		const query = vi.fn(async () => ({
			mailboxId: 'mb1',
			fromAddress: 'sender@example.com',
			subject: 'Hello',
		}));
		const mutation = vi.fn(async () => {
			throw new Error('backend unavailable');
		});
		const openComposer = vi.fn(async () => {});
		const convex = { query, mutation } as unknown as ConvexClient;

		await replyFromNotification(convex, 'm1', 'My reply words', { openComposer });

		expect(openComposer).toHaveBeenCalledTimes(1);
		const path = openComposer.mock.calls[0]?.[0] as string;
		const url = new URL(path, 'https://x');
		expect(url.pathname).toBe('/compose');
		expect(url.searchParams.get('body')).toBe('My reply words');
		expect(url.searchParams.get('to')).toBe('sender@example.com');
		expect(url.searchParams.get('subject')).toBe('Re: Hello');
	});

	it('still preserves the typed text when the original message cannot be re-read', async () => {
		const query = vi.fn(async () => {
			throw new Error('message gone');
		});
		const mutation = vi.fn(async () => {
			throw new Error('unused');
		});
		const openComposer = vi.fn(async () => {});
		const convex = { query, mutation } as unknown as ConvexClient;

		await replyFromNotification(convex, 'm1', 'Do not lose me', { openComposer });

		expect(openComposer).toHaveBeenCalledTimes(1);
		const path = openComposer.mock.calls[0]?.[0] as string;
		const url = new URL(path, 'https://x');
		expect(url.searchParams.get('body')).toBe('Do not lose me');
	});
});
