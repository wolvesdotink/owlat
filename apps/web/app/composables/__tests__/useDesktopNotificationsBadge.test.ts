/**
 * The dock/taskbar badge and the browser tab read the same count
 * (`useUnreadBadge`). These specs mount the real composables the way the
 * dashboard layout does and pin the desktop side of that contract: the native
 * badge repaints on every input of the count (a delivery, the device's badge
 * toggle, the per-user "count all mail" preference), the browser never
 * touches the native module, and the first delivery still seeds the backlog
 * silently.
 *
 * The mocked native module is imported once up front, so every later dynamic
 * import resolves from the module cache and `flushPromises` settles it; no
 * spec waits on the clock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

const { native } = vi.hoisted(() => ({
	native: {
		updateUnreadBadge: vi.fn(async (_count: number) => {}),
		sendDesktopNotification: vi.fn(async (..._args: unknown[]) => {}),
		sendActionableNotification: vi.fn(async (..._args: unknown[]) => {}),
		onNotificationAction: vi.fn(async () => () => {}),
	},
}));

vi.mock('@owlat/desktop/src/notifications', () => ({
	updateUnreadBadge: (count: number) => native.updateUnreadBadge(count),
	sendDesktopNotification: (...args: unknown[]) => native.sendDesktopNotification(...args),
	sendActionableNotification: (...args: unknown[]) => native.sendActionableNotification(...args),
	onNotificationAction: () => native.onNotificationAction(),
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

type Peek = { total: number; messages: Array<Record<string, unknown>> };

const isDesktop = ref(true);
const unread = ref<Peek | undefined>(undefined);
const badgeNonPeople = ref(true);
const appSettings = ref({ global: { notificationsEnabled: true, showUnreadBadge: true } });

function message(id: string, category?: string): Record<string, unknown> {
	return {
		messageId: id,
		threadId: `t-${id}`,
		fromName: id,
		fromAddress: `${id}@example.com`,
		subject: `About ${id}`,
		receivedAt: 1,
		...(category ? { category } : {}),
	};
}

function stubNuxt(): void {
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop }));
	vi.stubGlobal('requireConvex', () => ({ query: vi.fn(), mutation: vi.fn() }));
	vi.stubGlobal('usePostboxSettings', () => ({
		notifyAbout: ref('everything'),
		badgeNonPeople,
		quietHours: ref(null),
		hidePreview: ref(false),
	}));
	vi.stubGlobal('useDesktopNotificationPermission', () => ({
		canSend: ref(true),
		request: vi.fn(async () => {}),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useI18n', () => ({ t: (k: string) => k }));
	vi.stubGlobal('useCopyToClipboard', () => ({ copy: vi.fn() }));
	vi.stubGlobal('useDesktopAppSettings', () => ({
		settings: appSettings,
		workspaceLocal: () => ({ muteNotifications: false }),
	}));
	vi.stubGlobal('useDesktopWorkspaces', () => ({
		activeId: ref('ws-a'),
		workspaces: ref([{ id: 'ws-a', label: 'Acme' }]),
		switchTo: vi.fn(),
	}));
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: unknown) => {
		const resolved = typeof args === 'function' ? args() : args;
		const isUnread = JSON.stringify(resolved) === JSON.stringify({ limit: 5 });
		return { data: isUnread ? unread : ref(null) };
	});
	vi.stubGlobal('navigateTo', vi.fn());
}

async function mountDashboard(): Promise<VueWrapper> {
	const { useDesktopNotifications } = await import('../useDesktopNotifications');
	const { useUnreadBadge } = await import('../useUnreadBadge');
	const wrapper = mount(
		defineComponent({
			setup() {
				useDesktopNotifications(useUnreadBadge());
				return () => h('div');
			},
		})
	);
	await flushPromises();
	return wrapper;
}

function badgeWrites(): number[] {
	return native.updateUnreadBadge.mock.calls.map(([count]) => count);
}

beforeEach(async () => {
	vi.resetModules();
	stubNuxt();
	isDesktop.value = true;
	unread.value = undefined;
	badgeNonPeople.value = true;
	appSettings.value = { global: { notificationsEnabled: true, showUnreadBadge: true } };
	for (const fn of Object.values(native)) fn.mockClear();
	await import('@owlat/desktop/src/notifications');
});

describe('useDesktopNotifications: the dock badge', () => {
	it('paints nothing before the first delivery, then the count', async () => {
		const wrapper = await mountDashboard();
		expect(badgeWrites()).toEqual([]);

		unread.value = { total: 3, messages: [message('a', 'person')] };
		await flushPromises();
		expect(badgeWrites()).toEqual([3]);
		wrapper.unmount();
	});

	it('repaints when the "count all mail" preference flips, without another delivery', async () => {
		const wrapper = await mountDashboard();
		unread.value = {
			total: 20,
			messages: [message('a', 'person'), message('b', 'newsletter'), message('c')],
		};
		await flushPromises();

		badgeNonPeople.value = false;
		await flushPromises();
		expect(badgeWrites()).toEqual([20, 2]);

		badgeNonPeople.value = true;
		await flushPromises();
		expect(badgeWrites()).toEqual([20, 2, 20]);
		wrapper.unmount();
	});

	it('clears to zero when the device badge is switched off, and comes back on', async () => {
		const wrapper = await mountDashboard();
		unread.value = { total: 4, messages: [] };
		await flushPromises();

		appSettings.value = { global: { notificationsEnabled: true, showUnreadBadge: false } };
		await flushPromises();
		expect(badgeWrites()).toEqual([4, 0]);

		// While off, unread changes leave the cleared icon alone.
		unread.value = { total: 6, messages: [] };
		await flushPromises();
		expect(badgeWrites()).toEqual([4, 0]);

		appSettings.value = { global: { notificationsEnabled: true, showUnreadBadge: true } };
		await flushPromises();
		expect(badgeWrites()).toEqual([4, 0, 6]);
		wrapper.unmount();
	});

	it('seeds the backlog silently and notifies only for mail that arrives later', async () => {
		const wrapper = await mountDashboard();
		unread.value = { total: 1, messages: [message('old', 'person')] };
		await flushPromises();
		expect(native.sendActionableNotification).not.toHaveBeenCalled();

		unread.value = { total: 2, messages: [message('new', 'person'), message('old', 'person')] };
		await flushPromises();
		expect(native.sendActionableNotification).toHaveBeenCalledTimes(1);
		expect(native.sendActionableNotification.mock.calls[0]?.[2]).toBe('new');
		expect(badgeWrites()).toEqual([1, 2]);
		wrapper.unmount();
	});
});

describe('useDesktopNotifications in the browser', () => {
	it('never touches the native badge or notifications', async () => {
		isDesktop.value = false;
		const wrapper = await mountDashboard();
		unread.value = { total: 5, messages: [message('a', 'person')] };
		await flushPromises();
		badgeNonPeople.value = false;
		await flushPromises();
		unread.value = { total: 6, messages: [message('b', 'person'), message('a', 'person')] };
		await flushPromises();

		expect(native.updateUnreadBadge).not.toHaveBeenCalled();
		expect(native.sendActionableNotification).not.toHaveBeenCalled();
		expect(native.sendDesktopNotification).not.toHaveBeenCalled();
		expect(native.onNotificationAction).not.toHaveBeenCalled();
		wrapper.unmount();
	});
});
