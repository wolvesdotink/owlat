/**
 * The notification watchers read Convex query results, and those results are
 * immutable values that `useConvexQuery` hands over in a shallow ref: a new
 * delivery is a new object, an unchanged one keeps its identity. So a watcher
 * only needs the reference. These specs feed the composable shallow refs the
 * way the real query does and pin that it never walks a result (a nested field
 * nobody reads stays unread), while every replacement still drives the badge,
 * the toasts and the review-queue delta, and the first load stays silent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { defineComponent, h, ref, shallowRef } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

const { desktop } = vi.hoisted(() => ({
	desktop: {
		sendActionableNotification: vi.fn(async (..._args: unknown[]) => {}),
		sendDesktopNotification: vi.fn(async (..._args: unknown[]) => {}),
		updateUnreadBadge: vi.fn(async (_count: number) => {}),
	},
}));

vi.mock('@owlat/desktop/src/notifications', () => ({
	onNotificationAction: async () => () => {},
	sendActionableNotification: (...args: unknown[]) => desktop.sendActionableNotification(...args),
	sendDesktopNotification: (...args: unknown[]) => desktop.sendDesktopNotification(...args),
	updateUnreadBadge: (count: number) => desktop.updateUnreadBadge(count),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: 'main' }),
}));
vi.mock('@tauri-apps/api/window', () => ({
	getCurrentWindow: () => ({ show: async () => {}, setFocus: async () => {} }),
}));
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	getActiveWorkspace: () => ({ id: 'ws-a' }),
	isDesktopRuntime: () => true,
}));
vi.mock('~/composables/useLocalized', () => ({ useLocalized: () => (k: unknown) => String(k) }));

// Shallow, like `useConvexQuery`'s own `data`: only a new value triggers.
const unread = shallowRef<unknown>(undefined);
const inboundStats = shallowRef<unknown>(undefined);
const assignments = shallowRef<unknown>(undefined);
const showToast = vi.fn();

/** A nested value no consumer reads; any read of it means a result was traversed. */
let probeReads = 0;
function probe(): { readonly unused: number } {
	return {
		get unused() {
			probeReads += 1;
			return 0;
		},
	};
}

function stubNuxt(): void {
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop: ref(true) }));
	vi.stubGlobal('requireConvex', () => ({ query: vi.fn(), mutation: vi.fn() }));
	vi.stubGlobal('usePostboxSettings', () => ({
		notifyAbout: ref('everything'),
		badgeNonPeople: ref(true),
		quietHours: ref(null),
		hidePreview: ref(false),
	}));
	vi.stubGlobal('useDesktopNotificationPermission', () => ({
		canSend: ref(true),
		request: vi.fn(async () => {}),
	}));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useI18n', () => ({
		t: (k: string, params?: Record<string, unknown>) =>
			params && typeof params === 'object' ? `${k} ${JSON.stringify(params)}` : k,
	}));
	vi.stubGlobal('useCopyToClipboard', () => ({ copy: vi.fn(async () => true) }));
	vi.stubGlobal('useDesktopAppSettings', () => ({
		settings: ref({ global: { notificationsEnabled: true, showUnreadBadge: true } }),
		workspaceLocal: () => ({ muteNotifications: false }),
	}));
	vi.stubGlobal('useDesktopWorkspaces', () => ({
		activeId: ref('ws-a'),
		workspaces: ref([{ id: 'ws-a', label: 'Acme' }]),
		switchTo: vi.fn(async () => {}),
	}));
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: () => unknown) => {
		const resolved = typeof args === 'function' ? args() : args;
		if (resolved && typeof resolved === 'object' && 'limit' in resolved) return { data: unread };
		if (resolved && typeof resolved === 'object' && 'includeMentions' in resolved) {
			return { data: assignments };
		}
		return { data: inboundStats };
	});
	vi.stubGlobal('navigateTo', vi.fn());
}

// Unmounted after each case, so a failed assertion cannot leave its watchers
// reacting to the shared refs in the next case.
let mounted: VueWrapper | null = null;

async function mountDashboard(): Promise<void> {
	const { useDesktopNotifications } = await import('../useDesktopNotifications');
	mounted = mount(
		defineComponent({
			setup() {
				useDesktopNotifications();
				return () => h('div');
			},
		})
	);
}

afterEach(() => {
	mounted?.unmount();
	mounted = null;
});

function message(id: string, receivedAt: number) {
	return {
		messageId: id,
		threadId: `t-${id}`,
		fromName: 'Alice',
		fromAddress: 'alice@example.com',
		subject: `Subject ${id}`,
		category: 'person',
		receivedAt,
		extra: probe(),
	};
}

function notice(id: string, createdAt: number) {
	return {
		id,
		threadId: `t-${id}`,
		subject: `Subject ${id}`,
		assignedByName: 'Bob',
		createdAt,
		extra: probe(),
	};
}

beforeEach(() => {
	vi.resetModules();
	stubNuxt();
	unread.value = undefined;
	inboundStats.value = undefined;
	assignments.value = undefined;
	probeReads = 0;
	showToast.mockClear();
	desktop.sendActionableNotification.mockClear();
	desktop.sendDesktopNotification.mockClear();
	desktop.updateUnreadBadge.mockClear();
	sessionStorage.clear();
});

describe('useDesktopNotifications: query results are watched by identity', () => {
	it('never walks a delivered result', async () => {
		await mountDashboard();
		const now = Date.now();
		unread.value = { total: 1, messages: [message('m1', now)], extra: probe() };
		inboundStats.value = { draftReady: 0, extra: probe() };
		assignments.value = [notice('a1', now)];
		await flushPromises();

		unread.value = {
			total: 2,
			messages: [message('m2', now + 1), message('m1', now)],
			extra: probe(),
		};
		inboundStats.value = { draftReady: 1, extra: probe() };
		assignments.value = [notice('a2', now + 1), notice('a1', now)];
		await flushPromises();

		expect(probeReads).toBe(0);
	});

	it('repaints the badge on every new result and toasts only what arrived after the first load', async () => {
		await mountDashboard();
		const now = Date.now();
		unread.value = { total: 1, messages: [message('m1', now)] };
		await flushPromises();

		expect(desktop.updateUnreadBadge).toHaveBeenLastCalledWith(1);
		// The backlog present at first load is seeded, never toasted.
		expect(desktop.sendActionableNotification).not.toHaveBeenCalled();

		unread.value = { total: 2, messages: [message('m2', now + 1), message('m1', now)] };
		await flushPromises();

		expect(desktop.updateUnreadBadge).toHaveBeenLastCalledWith(2);
		expect(desktop.sendActionableNotification).toHaveBeenCalledTimes(1);
		expect(desktop.sendActionableNotification.mock.calls[0]?.[2]).toBe('m2');

		// A fresh object holding the same rows repaints the badge and toasts nothing.
		unread.value = { total: 2, messages: [message('m2', now + 1), message('m1', now)] };
		await flushPromises();

		expect(desktop.updateUnreadBadge).toHaveBeenCalledTimes(3);
		expect(desktop.sendActionableNotification).toHaveBeenCalledTimes(1);
	});

	it('announces only the growth of the review queue', async () => {
		await mountDashboard();
		inboundStats.value = { draftReady: 2 };
		await flushPromises();
		expect(desktop.sendDesktopNotification).not.toHaveBeenCalled();

		inboundStats.value = { draftReady: 5 };
		await flushPromises();
		expect(desktop.sendDesktopNotification).toHaveBeenCalledTimes(1);
		expect(desktop.sendDesktopNotification.mock.calls[0]?.[1]).toBe(
			'shared.useDesktopNotifications.draftsReady.body {"count":3}'
		);

		inboundStats.value = { draftReady: 4 };
		await flushPromises();
		expect(desktop.sendDesktopNotification).toHaveBeenCalledTimes(1);
	});

	it('seeds assignments silently and toasts each new one once', async () => {
		await mountDashboard();
		const now = Date.now();
		assignments.value = [notice('a1', now)];
		await flushPromises();
		expect(showToast).not.toHaveBeenCalled();

		assignments.value = [notice('a2', now + 1), notice('a1', now)];
		await flushPromises();
		expect(showToast).toHaveBeenCalledTimes(1);

		// Re-delivered as new objects: same ids, nothing to say.
		assignments.value = [notice('a2', now + 1), notice('a1', now)];
		await flushPromises();
		expect(showToast).toHaveBeenCalledTimes(1);
	});
});
