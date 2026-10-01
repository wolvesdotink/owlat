import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConvexClient } from 'convex/browser';
import { getFunctionName, type FunctionReference } from 'convex/server';
import {
	handleNotificationAction,
	runPendingAction,
	setupNotificationActionRouting,
	type NotificationRouting,
	type NotificationRoutingContext,
} from '../notificationActions.client';
import { PENDING_ACTION_FRESH_MS, PENDING_NOTIFICATION_ACTION_KEY } from '../notificationWorkspace';

// A fake Tauri event bus: `listen` registrations land in `listeners`, and the
// unlisten function removes them again. `registrationGate` holds a
// registration in flight so a test can unmount before it resolves.
const { listeners, bridge } = vi.hoisted(() => ({
	listeners: new Set<(payload: Record<string, unknown>) => void>(),
	bridge: {
		registrationGate: null as Promise<void> | null,
		windowLabel: 'main',
	},
}));

vi.mock('@owlat/desktop/src/notifications', () => ({
	onNotificationAction: async (cb: (payload: Record<string, unknown>) => void) => {
		if (bridge.registrationGate) await bridge.registrationGate;
		listeners.add(cb);
		return () => listeners.delete(cb);
	},
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: bridge.windowLabel }),
}));
vi.mock('@tauri-apps/api/window', () => ({
	getCurrentWindow: () => ({ show: async () => {}, setFocus: async () => {} }),
}));

function emit(payload: Record<string, unknown>): void {
	for (const cb of listeners) cb(payload);
}

/** Let the fire-and-forget handlers (and their dynamic imports) run out. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

interface StoredMessage {
	mailboxId: string;
	fromAddress: string;
	subject: string;
}

/**
 * One Owlat instance behind a Convex client: its own message table and a log
 * of every call it received, so a test can prove which backend an action hit.
 */
function fakeBackend(messages: Record<string, StoredMessage>) {
	const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
	const record = (ref: FunctionReference<'query' | 'mutation'>, args: Record<string, unknown>) => {
		const fn = getFunctionName(ref);
		calls.push({ fn, args });
		return fn;
	};
	const client = {
		query: vi.fn(async (ref: FunctionReference<'query'>, args: Record<string, unknown>) => {
			record(ref, args);
			const message = messages[args['messageId'] as string];
			if (!message) throw new Error('Message not found');
			return message;
		}),
		mutation: vi.fn(async (ref: FunctionReference<'mutation'>, args: Record<string, unknown>) => {
			const fn = record(ref, args);
			if (fn.endsWith('drafts:create')) return { draftId: 'draft-1' };
			return null;
		}),
	};
	return {
		client: client as unknown as ConvexClient,
		calls,
		names: () => calls.map((c) => c.fn),
	};
}

/** In-memory sessionStorage that survives a simulated webview reload. */
function memoryStorage(): Storage {
	const data = new Map<string, string>();
	return {
		get length() {
			return data.size;
		},
		clear: () => data.clear(),
		getItem: (k: string) => data.get(k) ?? null,
		key: (i: number) => [...data.keys()][i] ?? null,
		removeItem: (k: string) => void data.delete(k),
		setItem: (k: string, v: string) => void data.set(k, v),
	};
}

function context(
	overrides: Partial<NotificationRoutingContext> & { activeId?: string | null; known?: string[] }
): NotificationRoutingContext & {
	switchTo: ReturnType<typeof vi.fn>;
	onUnavailable: ReturnType<typeof vi.fn>;
	navigate: ReturnType<typeof vi.fn>;
	openComposer: ReturnType<typeof vi.fn>;
} {
	const { activeId = null, known = [], ...rest } = overrides;
	const switchTo = vi.fn(async () => {});
	const onUnavailable = vi.fn();
	const navigate = vi.fn();
	const openComposer = vi.fn(async () => {});
	return {
		convex: fakeBackend({}).client,
		navigate,
		openComposer,
		storage: memoryStorage(),
		authReady: async () => true,
		now: () => 1_000_000,
		workspaces: {
			activeId: () => activeId,
			exists: (id) => known.includes(id),
			switchTo,
			onUnavailable,
		},
		switchTo,
		onUnavailable,
		...rest,
	} as never;
}

const routings: NotificationRouting[] = [];
function setup(ctx: NotificationRoutingContext): NotificationRouting {
	const routing = setupNotificationActionRouting(ctx);
	routings.push(routing);
	return routing;
}

beforeEach(() => {
	bridge.registrationGate = null;
	bridge.windowLabel = 'main';
});

afterEach(() => {
	for (const r of routings.splice(0)) r.dispose();
	listeners.clear();
});

const message: StoredMessage = {
	mailboxId: 'mb-1',
	fromAddress: 'sender@example.com',
	subject: 'Hello',
};

// ── #950: one subscription per owner ────────────────────────────────────────

describe('notification routing subscription lifetime', () => {
	it('disposing the owner removes its listener', async () => {
		const routing = setup(context({}));
		await routing.ready;
		expect(listeners.size).toBe(1);

		routing.dispose();
		expect(listeners.size).toBe(0);
	});

	it('dashboard → welcome → dashboard leaves exactly one listener, and one Reply sends once', async () => {
		const backend = fakeBackend({ m1: message });
		const ctx = context({ convex: backend.client });

		// First dashboard mount, then the user leaves for /desktop/welcome.
		const first = setup(ctx);
		await first.ready;
		first.dispose();
		expect(listeners.size).toBe(0);

		// Back on the dashboard.
		const second = setup(ctx);
		await second.ready;
		expect(listeners.size).toBe(1);

		emit({ action: 'reply', messageId: 'm1', reply: 'Thanks!' });
		await settle();

		expect(backend.names()).toEqual([
			'mail/mailbox/messages:getMessage',
			'mail/drafts:create',
			'mail/drafts:update',
			'mail/drafts:send',
		]);
	});

	it('a newer registration replaces one that was never disposed', async () => {
		const backend = fakeBackend({ m1: message });
		const ctx = context({ convex: backend.client });
		await setup(ctx).ready;
		await setup(ctx).ready;
		await setup(ctx).ready;
		expect(listeners.size).toBe(1);

		emit({ action: 'archive', messageId: 'm1' });
		await settle();
		emit({ action: 'read', messageId: 'm1' });
		await settle();

		expect(backend.names()).toEqual([
			'mail/messageActions:archive',
			'mail/messageActions:markRead',
		]);
	});

	it('drops a listener whose registration resolves after the owner unmounted', async () => {
		let release!: () => void;
		bridge.registrationGate = new Promise<void>((resolve) => (release = resolve));

		const routing = setup(context({}));
		// Unmount while `listen` is still in flight.
		routing.dispose();
		release();
		await routing.ready;

		expect(listeners.size).toBe(0);
	});

	it('remounting while the first registration is still pending ends with one listener', async () => {
		let release!: () => void;
		bridge.registrationGate = new Promise<void>((resolve) => (release = resolve));
		const backend = fakeBackend({ m1: message });
		const ctx = context({ convex: backend.client });

		const first = setup(ctx);
		first.dispose();
		const second = setup(ctx);
		release();
		await Promise.all([first.ready, second.ready]);
		expect(listeners.size).toBe(1);

		emit({ action: 'read', messageId: 'm1' });
		await settle();
		expect(backend.names()).toEqual(['mail/messageActions:markRead']);
	});

	it('never subscribes from a secondary window (compose)', async () => {
		bridge.windowLabel = 'compose';
		const routing = setup(context({}));
		await routing.ready;
		expect(listeners.size).toBe(0);
	});

	it('routes a duplicated delivery of the same native notification once', async () => {
		const backend = fakeBackend({ m1: message });
		await setup(context({ convex: backend.client })).ready;

		emit({ action: 'archive', messageId: 'm1', notificationId: 41 });
		emit({ action: 'archive', messageId: 'm1', notificationId: 41 });
		await settle();

		expect(backend.names()).toEqual(['mail/messageActions:archive']);
	});
});

// ── #951: actions run in the workspace that sent the notification ───────────

describe('notification actions keep their workspace', () => {
	// Both instances have a message called `m1` (ids are instance-scoped, so they
	// can collide), with different senders. Routing must be keyed by workspace;
	// a validation failure on the wrong backend would not prove anything.
	const instanceA = () =>
		fakeBackend({ m1: { mailboxId: 'mb-a', fromAddress: 'alice@a.example.com', subject: 'A' } });
	const instanceB = () =>
		fakeBackend({ m1: { mailboxId: 'mb-b', fromAddress: 'bob@b.example.com', subject: 'B' } });

	it('runs an action from the active workspace in place', async () => {
		const a = instanceA();
		const ctx = context({ convex: a.client, activeId: 'ws-a', known: ['ws-a', 'ws-b'] });

		await handleNotificationAction(
			{ action: 'archive', messageId: 'm1', workspaceId: 'ws-a' },
			ctx
		);

		expect(a.names()).toEqual(['mail/messageActions:archive']);
		expect(ctx.switchTo).not.toHaveBeenCalled();
	});

	it.each([
		['archive', 'mail/messageActions:archive', { messageIds: ['m1'] }],
		['read', 'mail/messageActions:markRead', { messageId: 'm1', seen: true }],
	])('%s from A while B is active hits only A, after switching', async (action, fn, args) => {
		const a = instanceA();
		const b = instanceB();
		const storage = memoryStorage();

		// Page load bound to B.
		const onB = context({ convex: b.client, storage, activeId: 'ws-b', known: ['ws-a', 'ws-b'] });
		await handleNotificationAction({ action, messageId: 'm1', workspaceId: 'ws-a' }, onB);
		expect(b.calls).toEqual([]);
		expect(onB.switchTo).toHaveBeenCalledWith('ws-a', '/dashboard');

		// The switch reloads the webview into A; its dashboard picks the action up.
		const onA = context({ convex: a.client, storage, activeId: 'ws-a', known: ['ws-a', 'ws-b'] });
		await runPendingAction(onA);

		expect(a.calls).toEqual([{ fn, args }]);
		expect(b.calls).toEqual([]);
		expect(storage.getItem(PENDING_NOTIFICATION_ACTION_KEY)).toBeNull();
	});

	it('Reply from A while B is active sends from A to A’s sender, keeping the text', async () => {
		const a = instanceA();
		const b = instanceB();
		const storage = memoryStorage();

		const onB = context({ convex: b.client, storage, activeId: 'ws-b', known: ['ws-a', 'ws-b'] });
		await handleNotificationAction(
			{ action: 'reply', messageId: 'm1', reply: 'See you at 3', workspaceId: 'ws-a' },
			onB
		);
		expect(b.calls).toEqual([]);

		const onA = context({ convex: a.client, storage, activeId: 'ws-a', known: ['ws-a', 'ws-b'] });
		await runPendingAction(onA);

		expect(b.calls).toEqual([]);
		expect(a.names()).toEqual([
			'mail/mailbox/messages:getMessage',
			'mail/drafts:create',
			'mail/drafts:update',
			'mail/drafts:send',
		]);
		expect(a.calls[1]?.args).toMatchObject({ mailboxId: 'mb-a', inReplyToMessageId: 'm1' });
		expect(a.calls[2]?.args).toMatchObject({ bodyText: 'See you at 3' });
	});

	it('Open from A while B is active switches to A and lands on the thread', async () => {
		const b = instanceB();
		const ctx = context({ convex: b.client, activeId: 'ws-b', known: ['ws-a', 'ws-b'] });

		await handleNotificationAction(
			{ action: 'open', messageId: 'm1', folderRole: 'inbox', workspaceId: 'ws-a' },
			ctx
		);

		expect(ctx.switchTo).toHaveBeenCalledWith('ws-a', '/dashboard/postbox/inbox/m1');
		expect(ctx.navigate).not.toHaveBeenCalled();
		expect(ctx.storage?.getItem(PENDING_NOTIFICATION_ACTION_KEY)).toBeNull();
		expect(b.calls).toEqual([]);
	});

	it.each(['open', 'archive', 'read', 'reply'])(
		'%s from a removed workspace reports it and calls nothing',
		async (action) => {
			const b = instanceB();
			const ctx = context({ convex: b.client, activeId: 'ws-b', known: ['ws-b'] });

			await handleNotificationAction(
				{ action, messageId: 'm1', reply: 'keep me', workspaceId: 'ws-gone' },
				ctx
			);

			expect(b.calls).toEqual([]);
			expect(ctx.switchTo).not.toHaveBeenCalled();
			expect(ctx.navigate).not.toHaveBeenCalled();
			expect(ctx.openComposer).not.toHaveBeenCalled();
			expect(ctx.onUnavailable).toHaveBeenCalledTimes(1);
			if (action === 'reply') {
				expect(ctx.onUnavailable).toHaveBeenCalledWith({
					type: 'reply',
					messageId: 'm1',
					text: 'keep me',
				});
			}
		}
	);

	it('lands on the thread when the action cannot be carried across the reload', async () => {
		const b = instanceB();
		const ctx = context({ convex: b.client, storage: null, activeId: 'ws-b', known: ['ws-a'] });

		await handleNotificationAction(
			{ action: 'archive', messageId: 'm1', workspaceId: 'ws-a' },
			ctx
		);

		expect(ctx.switchTo).toHaveBeenCalledWith('ws-a', '/dashboard/postbox/inbox/m1');
		expect(b.calls).toEqual([]);
	});

	it('keeps a carried action for its own workspace when another one boots', async () => {
		const b = instanceB();
		const storage = memoryStorage();
		const onB = context({ convex: b.client, storage, activeId: 'ws-b', known: ['ws-a'] });
		await handleNotificationAction({ action: 'read', messageId: 'm1', workspaceId: 'ws-a' }, onB);

		// The reload landed in B after all (say the switch was undone): nothing runs.
		await runPendingAction(onB);
		expect(b.calls).toEqual([]);
		expect(storage.getItem(PENDING_NOTIFICATION_ACTION_KEY)).not.toBeNull();
	});

	it('waits for auth before running a carried action (expired session)', async () => {
		const a = instanceA();
		const b = instanceB();
		const storage = memoryStorage();
		const onB = context({ convex: b.client, storage, activeId: 'ws-b', known: ['ws-a'] });
		await handleNotificationAction(
			{ action: 'reply', messageId: 'm1', reply: 'later', workspaceId: 'ws-a' },
			onB
		);

		const signedOut = context({
			convex: a.client,
			storage,
			activeId: 'ws-a',
			authReady: async () => false,
		});
		await runPendingAction(signedOut);
		expect(a.calls).toEqual([]);
		expect(storage.getItem(PENDING_NOTIFICATION_ACTION_KEY)).not.toBeNull();

		// Signed back in long after the switch: the reply opens prefilled instead
		// of going out unattended.
		const signedIn = context({
			convex: a.client,
			storage,
			activeId: 'ws-a',
			now: () => 1_000_000 + PENDING_ACTION_FRESH_MS + 1,
		});
		await runPendingAction(signedIn);

		expect(a.names()).toEqual(['mail/mailbox/messages:getMessage']);
		expect(signedIn.openComposer).toHaveBeenCalledTimes(1);
		const url = new URL(signedIn.openComposer.mock.calls[0]?.[0] as string, 'https://x');
		expect(url.searchParams.get('to')).toBe('alice@a.example.com');
		expect(url.searchParams.get('body')).toBe('later');
		expect(b.calls).toEqual([]);
	});

	it('drops a stale carried triage action', async () => {
		const a = instanceA();
		const storage = memoryStorage();
		const onB = context({ storage, activeId: 'ws-b', known: ['ws-a'] });
		await handleNotificationAction(
			{ action: 'archive', messageId: 'm1', workspaceId: 'ws-a' },
			onB
		);

		const onA = context({
			convex: a.client,
			storage,
			activeId: 'ws-a',
			now: () => 1_000_000 + PENDING_ACTION_FRESH_MS + 1,
		});
		await runPendingAction(onA);

		expect(a.calls).toEqual([]);
		expect(storage.getItem(PENDING_NOTIFICATION_ACTION_KEY)).toBeNull();
	});

	it('runs the carried action once the routing registers in the target workspace', async () => {
		const a = instanceA();
		const storage = memoryStorage();
		const onB = context({ storage, activeId: 'ws-b', known: ['ws-a'] });
		await handleNotificationAction({ action: 'read', messageId: 'm1', workspaceId: 'ws-a' }, onB);

		await setup(context({ convex: a.client, storage, activeId: 'ws-a' })).ready;

		expect(a.names()).toEqual(['mail/messageActions:markRead']);
	});
});
