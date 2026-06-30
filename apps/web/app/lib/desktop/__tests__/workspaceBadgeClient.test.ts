import { describe, it, expect, vi, beforeEach } from 'vitest';

// The factory imports the Convex browser client and the @owlat/api function
// references. Stub the client so we can drive its onUpdate callbacks, and the
// keychain bridge so cookie reads resolve synchronously. The @owlat/api stub
// only needs the two query references to be distinguishable objects.
const onUpdate = vi.fn();
const setAuth = vi.fn();
const close = vi.fn();
vi.mock('convex/browser', () => ({
	ConvexClient: class {
		onUpdate = onUpdate;
		setAuth = setAuth;
		close = close;
	},
}));
vi.mock('@owlat/api', () => ({
	api: {
		inbox: { queries: { getInboundStats: { _ref: 'getInboundStats' } } },
		chat: { mentions: { countMyUnreadMentions: { _ref: 'countMyUnreadMentions' } } },
	},
}));

import { cookieStringFromBlob, createWorkspaceBadgeClient } from '../workspaceBadgeClient';
import type { WorkspaceConfig } from '../workspaceTypes';

function blobWith(jar: Record<string, { value: string; expires?: string | null }>): string {
	return JSON.stringify({ 'better-auth_cookie': JSON.stringify(jar) });
}

const ws: WorkspaceConfig = {
	id: 'ws-1',
	label: 'Acme',
	siteUrl: 'https://acme.example',
	convexUrl: 'https://acme.convex.cloud',
	convexSiteUrl: 'https://acme.convex.site',
	userId: 'u1',
	tokenRef: 'owlat-ws:ws-1',
	addedAt: 0,
	lastActiveAt: 0,
};

describe('cookieStringFromBlob', () => {
	it('joins non-expired cookie entries into a Cookie header string', () => {
		const blob = blobWith({
			'better-auth.session_token': { value: 'abc', expires: null },
			'better-auth.csrf': { value: 'xyz' },
		});
		const cookie = cookieStringFromBlob(blob);
		expect(cookie).toContain('better-auth.session_token=abc');
		expect(cookie).toContain('better-auth.csrf=xyz');
	});

	it('drops expired entries', () => {
		const blob = blobWith({
			fresh: { value: 'keep', expires: new Date(Date.now() + 60_000).toISOString() },
			stale: { value: 'drop', expires: new Date(Date.now() - 60_000).toISOString() },
		});
		const cookie = cookieStringFromBlob(blob);
		expect(cookie).toContain('fresh=keep');
		expect(cookie).not.toContain('stale=drop');
	});

	it('returns empty string for null, missing jar, or corrupt JSON', () => {
		expect(cookieStringFromBlob(null)).toBe('');
		expect(cookieStringFromBlob('{}')).toBe('');
		expect(cookieStringFromBlob('not json')).toBe('');
	});
});

describe('createWorkspaceBadgeClient', () => {
	beforeEach(() => {
		onUpdate.mockReset();
		setAuth.mockReset();
		close.mockReset();
	});

	it('reports inbox drafts + chat mentions as a combined count', () => {
		const counts: number[] = [];
		// Capture each query's success callback so we can fire them.
		const callbacks: Record<string, (v: unknown) => void> = {};
		onUpdate.mockImplementation((ref: { _ref: string }, _args, onSuccess: (v: unknown) => void) => {
			callbacks[ref._ref] = onSuccess;
			return () => {};
		});

		createWorkspaceBadgeClient(ws, (c) => counts.push(c));

		callbacks['getInboundStats']!({ draftReady: 3 });
		callbacks['countMyUnreadMentions']!(2);

		expect(counts.at(-1)).toBe(5);
		expect(setAuth).toHaveBeenCalledTimes(1);
	});

	it('treats a query error as a zero contribution', () => {
		const counts: number[] = [];
		const success: Record<string, (v: unknown) => void> = {};
		const error: Record<string, (e: Error) => void> = {};
		onUpdate.mockImplementation(
			(ref: { _ref: string }, _args, onSuccess: (v: unknown) => void, onError: (e: Error) => void) => {
				success[ref._ref] = onSuccess;
				error[ref._ref] = onError;
				return () => {};
			},
		);

		createWorkspaceBadgeClient(ws, (c) => counts.push(c));

		success['getInboundStats']!({ draftReady: 4 });
		error['countMyUnreadMentions']!(new Error('not an admin'));

		expect(counts.at(-1)).toBe(4);
	});

	it('unsubscribes and closes the client on close()', () => {
		const unsubInbox = vi.fn();
		const unsubMentions = vi.fn();
		onUpdate.mockReturnValueOnce(unsubInbox).mockReturnValueOnce(unsubMentions);

		const client = createWorkspaceBadgeClient(ws, () => {});
		client.close();

		expect(unsubInbox).toHaveBeenCalledTimes(1);
		expect(unsubMentions).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});
});
