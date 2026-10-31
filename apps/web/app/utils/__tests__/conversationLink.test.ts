/**
 * The conversation link both ends agree on: what "Copy link" / "Share in chat…"
 * build, which origin they point at (the desktop app's webview origin is not
 * one), and which URLs the chat list turns back into in-app links.
 */
import { describe, expect, it } from 'vitest';
import {
	type ConversationLinkTarget,
	conversationLinkOrigin,
	conversationLinkPath,
	splitConversationLinks,
} from '../conversationLink';

const ORIGIN = 'https://mail.owlat.example';

describe('conversationLinkPath', () => {
	it('names the Postbox message, its folder and the mailbox it lives in', () => {
		expect(
			conversationLinkPath({
				kind: 'postbox',
				messageId: 'm1',
				mailboxId: 'mb1',
				folder: 'archive',
			})
		).toBe('/dashboard/postbox/archive/m1?mailbox=mb1');
	});

	it('falls back to the inbox segment when the reader has no folder', () => {
		expect(conversationLinkPath({ kind: 'postbox', messageId: 'm1', mailboxId: 'mb1' })).toBe(
			'/dashboard/postbox/inbox/m1?mailbox=mb1'
		);
		expect(
			conversationLinkPath({ kind: 'postbox', messageId: 'm1', mailboxId: 'mb1', folder: null })
		).toBe('/dashboard/postbox/inbox/m1?mailbox=mb1');
	});

	it('encodes every id, so an odd one cannot change the route', () => {
		expect(
			conversationLinkPath({ kind: 'postbox', messageId: 'a/b', mailboxId: 'x&y', folder: 'f?' })
		).toBe('/dashboard/postbox/f%3F/a%2Fb?mailbox=x%26y');
		expect(conversationLinkPath({ kind: 'team', threadId: 't 1' })).toBe('/dashboard/inbox/t%201');
	});

	it('names the Team Inbox thread', () => {
		expect(conversationLinkPath({ kind: 'team', threadId: 'th1' })).toBe('/dashboard/inbox/th1');
	});
});

describe('conversationLinkOrigin', () => {
	it('uses the page origin in a browser', () => {
		expect(
			conversationLinkOrigin({ desktop: false, locationOrigin: 'http://localhost:3000' })
		).toBe('http://localhost:3000');
	});

	it("uses the workspace's web address in the desktop app, never the webview origin", () => {
		expect(
			conversationLinkOrigin({
				desktop: true,
				workspaceSiteUrl: `${ORIGIN}/some/path`,
				locationOrigin: 'tauri://localhost',
			})
		).toBe(ORIGIN);
	});

	it('has no origin to offer without an HTTP(S) address', () => {
		expect(
			conversationLinkOrigin({ desktop: true, locationOrigin: 'tauri://localhost' })
		).toBeNull();
		expect(
			conversationLinkOrigin({
				desktop: true,
				workspaceSiteUrl: 'not a url',
				locationOrigin: 'tauri://localhost',
			})
		).toBeNull();
		expect(
			conversationLinkOrigin({ desktop: false, locationOrigin: 'tauri://localhost' })
		).toBeNull();
	});
});

describe('splitConversationLinks', () => {
	it('reads back every link conversationLinkPath builds', () => {
		const targets: ConversationLinkTarget[] = [
			{ kind: 'postbox', messageId: 'm1', mailboxId: 'mb1', folder: 'inbox' },
			{ kind: 'postbox', messageId: 'm2', mailboxId: 'mb2', folder: 'k57f0c2' },
			{ kind: 'team', threadId: 'th1' },
		];
		for (const target of targets) {
			const path = conversationLinkPath(target);
			expect(splitConversationLinks(`${ORIGIN}${path}`, ORIGIN)).toEqual([
				{ kind: 'link', value: `${ORIGIN}${path}`, path },
			]);
		}
	});

	it('keeps the text around a link, and the punctuation that ends a sentence', () => {
		const url = `${ORIGIN}/dashboard/inbox/th1`;
		expect(splitConversationLinks(`See ${url}. And (${url}), thanks`, ORIGIN)).toEqual([
			{ kind: 'text', value: 'See ' },
			{ kind: 'link', value: url, path: '/dashboard/inbox/th1' },
			{ kind: 'text', value: '. And (' },
			{ kind: 'link', value: url, path: '/dashboard/inbox/th1' },
			{ kind: 'text', value: '), thanks' },
		]);
	});

	it('leaves other hosts and other routes as plain text', () => {
		const text = [
			'https://evil.example/dashboard/inbox/th1',
			`${ORIGIN}/dashboard/settings`,
			`${ORIGIN}/dashboard/postbox/inbox`,
			`http://mail.owlat.example/dashboard/inbox/th1`,
		].join(' ');
		expect(splitConversationLinks(text, ORIGIN)).toEqual([{ kind: 'text', value: text }]);
	});

	it('renders nothing as a link when there is no origin to match', () => {
		const text = `${ORIGIN}/dashboard/inbox/th1`;
		expect(splitConversationLinks(text, null)).toEqual([{ kind: 'text', value: text }]);
	});

	it('returns no segment for empty text', () => {
		expect(splitConversationLinks('', ORIGIN)).toEqual([]);
	});
});
