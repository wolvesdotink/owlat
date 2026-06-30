import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The module under test imports `completeConnection` (the workspace handshake)
// from a composable whose entry transitively pulls in better-auth + Convex
// singletons, and it dynamically imports the Tauri compose bridge. Neither is
// relevant to the routing logic under test, so stub both so the module imports
// cleanly and we can assert on the calls.
const completeConnection = vi.fn();
vi.mock('~/composables/useDesktopWorkspaces', () => ({
	completeConnection: (...args: unknown[]) => completeConnection(...args),
}));

const openCompose = vi.fn();
vi.mock('@owlat/desktop/src/compose', () => ({
	openCompose: (...args: unknown[]) => openCompose(...args),
}));

import { handleDeepLink } from '../deepLink.client';

describe('handleDeepLink', () => {
	let assign: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		completeConnection.mockReset().mockResolvedValue(undefined);
		openCompose.mockReset().mockResolvedValue(undefined);
		assign = vi.fn();
		// happy-dom's window.location.assign is a no-op; replace it so we can
		// observe the navigation target.
		Object.defineProperty(window.location, 'assign', { value: assign, configurable: true, writable: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('owlat://auth handshake', () => {
		it('redeems the one-time token + state into the workspace connection', async () => {
			await handleDeepLink('owlat://auth?ott=tok123&state=nonceABC');
			expect(completeConnection).toHaveBeenCalledTimes(1);
			expect(completeConnection).toHaveBeenCalledWith({ ott: 'tok123', state: 'nonceABC' });
			expect(assign).not.toHaveBeenCalled();
		});

		it('does nothing when the one-time token or state is missing', async () => {
			await handleDeepLink('owlat://auth?ott=tok123');
			await handleDeepLink('owlat://auth?state=nonceABC');
			expect(completeConnection).not.toHaveBeenCalled();
		});

		it('swallows a failed connection without throwing', async () => {
			completeConnection.mockRejectedValueOnce(new Error('boom'));
			vi.spyOn(console, 'error').mockImplementation(() => {});
			await expect(handleDeepLink('owlat://auth?ott=t&state=s')).resolves.toBeUndefined();
			expect(completeConnection).toHaveBeenCalledTimes(1);
		});
	});

	describe('mailto: links', () => {
		it('parses the recipient + subject and opens the compose window', async () => {
			await handleDeepLink('mailto:user@example.com?subject=Hello%20there');
			expect(openCompose).toHaveBeenCalledTimes(1);
			const path = openCompose.mock.calls[0]![0] as string;
			expect(path.startsWith('/compose?')).toBe(true);
			const params = new URLSearchParams(path.slice('/compose?'.length));
			expect(params.get('to')).toBe('user@example.com');
			expect(params.get('subject')).toBe('Hello there');
			expect(completeConnection).not.toHaveBeenCalled();
		});

		it('forwards cc, bcc, and body per RFC-6068', async () => {
			await handleDeepLink(
				'mailto:user@example.com?subject=Hi&cc=a@x.com&bcc=b@y.com&body=Line%20one'
			);
			const path = openCompose.mock.calls[0]![0] as string;
			const params = new URLSearchParams(path.slice('/compose?'.length));
			expect(params.get('to')).toBe('user@example.com');
			expect(params.get('cc')).toBe('a@x.com');
			expect(params.get('bcc')).toBe('b@y.com');
			expect(params.get('body')).toBe('Line one');
		});

		it('opens compose with just the recipient when no subject is present', async () => {
			await handleDeepLink('mailto:user@example.com');
			expect(openCompose).toHaveBeenCalledTimes(1);
			const path = openCompose.mock.calls[0]![0] as string;
			const params = new URLSearchParams(path.slice('/compose?'.length));
			expect(params.get('to')).toBe('user@example.com');
			expect(params.get('subject')).toBeNull();
		});

		it('swallows a compose-bridge failure without throwing', async () => {
			openCompose.mockRejectedValueOnce(new Error('no tauri'));
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			await expect(handleDeepLink('mailto:user@example.com')).resolves.toBeUndefined();
		});
	});

	describe('navigation links', () => {
		it('routes owlat://thread/{id} to the inbox SPA path', async () => {
			await handleDeepLink('owlat://thread/abc123');
			expect(assign).toHaveBeenCalledTimes(1);
			expect(assign).toHaveBeenCalledWith('/dashboard/inbox/abc123');
			expect(completeConnection).not.toHaveBeenCalled();
		});

		it('routes owlat://chat/{id} to the chat SPA path', async () => {
			await handleDeepLink('owlat://chat/xyz789');
			expect(assign).toHaveBeenCalledTimes(1);
			expect(assign).toHaveBeenCalledWith('/dashboard/chat/xyz789');
		});

		it('routes other known prefixes (knowledge/file/contact)', async () => {
			await handleDeepLink('owlat://knowledge/k1');
			await handleDeepLink('owlat://file/f1');
			await handleDeepLink('owlat://contact/c1');
			expect(assign.mock.calls.map((c) => c[0])).toEqual([
				'/dashboard/knowledge/k1',
				'/dashboard/files/f1',
				'/dashboard/audience/contacts/c1',
			]);
		});

		it('falls back to /dashboard/{rest} for an unrecognised host', async () => {
			await handleDeepLink('owlat://settings/profile');
			expect(assign).toHaveBeenCalledWith('/dashboard/settings/profile');
		});
	});

	describe('unknown / malformed links', () => {
		it('ignores a non-URL string without throwing', async () => {
			await expect(handleDeepLink('not a url')).resolves.toBeUndefined();
			expect(assign).not.toHaveBeenCalled();
			expect(completeConnection).not.toHaveBeenCalled();
			expect(openCompose).not.toHaveBeenCalled();
		});

		it('ignores links with an unrelated protocol', async () => {
			await handleDeepLink('https://example.com/thread/1');
			expect(assign).not.toHaveBeenCalled();
			expect(completeConnection).not.toHaveBeenCalled();
			expect(openCompose).not.toHaveBeenCalled();
		});

		it('does not navigate for a bare owlat:// link with no path', async () => {
			await handleDeepLink('owlat://');
			expect(assign).not.toHaveBeenCalled();
			expect(completeConnection).not.toHaveBeenCalled();
		});
	});
});
