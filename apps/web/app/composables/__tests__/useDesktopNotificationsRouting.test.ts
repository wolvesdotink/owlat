/**
 * The dashboard layout owns the notification-action subscription through
 * `useDesktopNotifications`. These specs mount the real composable the way the
 * layout does and pin two contracts: the subscription lives exactly as long as
 * its owner (#950), and every actionable notification names the workspace it
 * was sent from (#951).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

const { listeners, bridge, sendActionableNotification } = vi.hoisted(() => ({
	listeners: new Set<(payload: Record<string, unknown>) => void>(),
	bridge: {
		registrationGate: null as Promise<void> | null,
		windowLabel: 'main',
	},
	sendActionableNotification: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock('@owlat/desktop/src/notifications', () => ({
	onNotificationAction: async (cb: (payload: Record<string, unknown>) => void) => {
		if (bridge.registrationGate) await bridge.registrationGate;
		listeners.add(cb);
		return () => listeners.delete(cb);
	},
	sendActionableNotification: (...args: unknown[]) => sendActionableNotification(...args),
	sendDesktopNotification: vi.fn(async () => {}),
	updateUnreadBadge: vi.fn(async () => {}),
}));
vi.mock('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({ label: bridge.windowLabel }),
}));
vi.mock('@tauri-apps/api/window', () => ({
	getCurrentWindow: () => ({ show: async () => {}, setFocus: async () => {} }),
}));
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	getActiveWorkspace: () => ({ id: 'ws-a' }),
	isDesktopRuntime: () => true,
}));
vi.mock('~/composables/useLocalized', () => ({ useLocalized: () => (k: unknown) => String(k) }));

const unread = ref<{ total: number; messages: unknown[] } | null>(null);
const showToast = vi.fn();
const copy = vi.fn(async (_text: string) => true);
const switchTo = vi.fn(async (..._args: unknown[]) => {});

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
	vi.stubGlobal('useCopyToClipboard', () => ({ copy }));
	vi.stubGlobal('useDesktopAppSettings', () => ({
		settings: ref({ global: { notificationsEnabled: true, showUnreadBadge: true } }),
		workspaceLocal: () => ({ muteNotifications: false }),
	}));
	vi.stubGlobal('useDesktopWorkspaces', () => ({
		activeId: ref('ws-a'),
		workspaces: ref([
			{ id: 'ws-a', label: 'Acme' },
			{ id: 'ws-b', label: 'Globex' },
		]),
		switchTo,
	}));
	vi.stubGlobal('useConvexQuery', (_fn: unknown, args: () => unknown) => {
		// Only the unread peek feeds this spec; the other queries stay empty.
		const isUnread =
			typeof args === 'function' && JSON.stringify(args()) === JSON.stringify({ limit: 5 });
		return { data: isUnread ? unread : ref(null) };
	});
	vi.stubGlobal('navigateTo', vi.fn());
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function mountDashboard(): Promise<VueWrapper> {
	const { useDesktopNotifications } = await import('../useDesktopNotifications');
	return mount(
		defineComponent({
			setup() {
				useDesktopNotifications();
				return () => h('div');
			},
		})
	);
}

beforeEach(() => {
	vi.resetModules();
	stubNuxt();
	listeners.clear();
	bridge.registrationGate = null;
	bridge.windowLabel = 'main';
	unread.value = null;
	sendActionableNotification.mockClear();
	showToast.mockClear();
	copy.mockClear();
	switchTo.mockClear();
	sessionStorage.clear();
});

describe('useDesktopNotifications: notification action subscription', () => {
	it('dashboard → welcome → dashboard keeps exactly one listener', async () => {
		const first = await mountDashboard();
		await settle();
		expect(listeners.size).toBe(1);

		first.unmount(); // off to /desktop/welcome
		expect(listeners.size).toBe(0);

		const second = await mountDashboard();
		await settle();
		expect(listeners.size).toBe(1);
		second.unmount();
		expect(listeners.size).toBe(0);
	});

	it('an unmount while registration is pending leaves no listener behind', async () => {
		let release!: () => void;
		bridge.registrationGate = new Promise<void>((resolve) => (release = resolve));

		const wrapper = await mountDashboard();
		wrapper.unmount();
		release();
		await settle();

		expect(listeners.size).toBe(0);
	});

	it('a compose window mounting the composable does not subscribe', async () => {
		bridge.windowLabel = 'compose';
		const wrapper = await mountDashboard();
		await settle();
		expect(listeners.size).toBe(0);
		wrapper.unmount();
	});
});

describe('useDesktopNotifications: workspace provenance', () => {
	it('names the sending workspace on every actionable notification', async () => {
		const wrapper = await mountDashboard();
		unread.value = { total: 0, messages: [] };
		await settle();

		unread.value = {
			total: 1,
			messages: [
				{
					messageId: 'm1',
					threadId: 't1',
					fromName: 'Alice',
					fromAddress: 'alice@example.com',
					subject: 'Hi',
					category: 'person',
					receivedAt: Date.now(),
				},
			],
		};
		await settle();

		expect(sendActionableNotification).toHaveBeenCalledTimes(1);
		expect(sendActionableNotification.mock.calls[0]?.slice(2)).toEqual(['m1', 'inbox', 'ws-a']);
		wrapper.unmount();
	});
});

describe('useDesktopNotifications: a reply that cannot reach its workspace', () => {
	it('stays in this workspace and offers the typed reply to copy', async () => {
		const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new DOMException('quota', 'QuotaExceededError');
		});
		try {
			const wrapper = await mountDashboard();
			await settle();
			for (const cb of listeners) {
				cb({ action: 'reply', messageId: 'm1', reply: 'See you at 3', workspaceId: 'ws-b' });
			}
			await settle();

			expect(switchTo).not.toHaveBeenCalled();
			expect(showToast).toHaveBeenCalledTimes(1);
			const [message, type, options] = showToast.mock.calls[0] ?? [];
			expect(message).toBe('shared.useDesktopNotifications.replyNotCarried {"workspace":"Globex"}');
			expect(type).toBe('warning');
			expect(options).toMatchObject({ durationMs: 0 });
			options.action.onAction();
			expect(copy).toHaveBeenCalledWith('See you at 3');
			wrapper.unmount();
		} finally {
			setItem.mockRestore();
		}
	});
});
