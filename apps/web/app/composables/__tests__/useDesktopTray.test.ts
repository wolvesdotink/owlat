/**
 * The tray icon is fed from the same unread peek as the dock badge. These
 * specs mount the composable the way the dashboard layout does and pin what
 * reaches the native bridge: the content follows every input, the stored
 * tray settings are never overwritten by defaults before they load, leaving
 * the dashboard clears the content, and the browser never touches the bridge.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

const { native } = vi.hoisted(() => ({
	native: {
		updateTray: vi.fn(async (_content: unknown) => {}),
		setTrayPreferences: vi.fn(async (_preferences: unknown) => {}),
	},
}));

vi.mock('@owlat/desktop/src/tray', () => ({
	updateTray: (content: unknown) => native.updateTray(content),
	setTrayPreferences: (preferences: unknown) => native.setTrayPreferences(preferences),
}));
vi.mock('~/lib/desktop/activeWorkspace', () => ({
	getActiveWorkspace: () => ({ id: 'ws-a' }),
}));

type Peek = { total: number; messages: Array<Record<string, unknown>> };

const isDesktop = ref(true);
const data = ref<Peek | undefined>(undefined);
const count = ref<number | null>(null);
const hidePreview = ref(false);
const isReady = ref(true);
const settings = ref({
	global: { notificationsEnabled: true, showTrayIcon: true, closeToTray: true },
});

function message(id: string): Record<string, unknown> {
	return {
		messageId: id,
		threadId: `t-${id}`,
		fromName: `Sender ${id}`,
		fromAddress: `${id}@example.com`,
		subject: `About ${id}`,
		receivedAt: 1,
	};
}

async function mountDashboard(): Promise<VueWrapper> {
	const { useDesktopTray } = await import('../useDesktopTray');
	const wrapper = mount(
		defineComponent({
			setup() {
				useDesktopTray({ data, count } as never);
				return () => h('div');
			},
		})
	);
	await flushPromises();
	return wrapper;
}

function contentWrites(): unknown[] {
	return native.updateTray.mock.calls.map(([content]) => content);
}

beforeEach(async () => {
	vi.resetModules();
	vi.stubGlobal('useDesktopContext', () => ({ isDesktop }));
	vi.stubGlobal('usePostboxSettings', () => ({ hidePreview }));
	vi.stubGlobal('useDesktopAppSettings', () => ({ settings, isReady }));
	isDesktop.value = true;
	data.value = undefined;
	count.value = null;
	hidePreview.value = false;
	isReady.value = true;
	settings.value = {
		global: { notificationsEnabled: true, showTrayIcon: true, closeToTray: true },
	};
	for (const fn of Object.values(native)) fn.mockClear();
	await import('@owlat/desktop/src/tray');
});

describe('useDesktopTray: the content', () => {
	it('reports the count and newest unread mail of the active workspace', async () => {
		const wrapper = await mountDashboard();
		data.value = { total: 2, messages: [message('a'), message('b')] };
		count.value = 2;
		await flushPromises();
		expect(contentWrites().at(-1)).toEqual({
			unread: 2,
			messages: [
				{ messageId: 'a', sender: 'Sender a', subject: 'About a' },
				{ messageId: 'b', sender: 'Sender b', subject: 'About b' },
			],
			workspaceId: 'ws-a',
			notificationsPaused: false,
		});
		wrapper.unmount();
	});

	it('follows the preview and notification switches without another delivery', async () => {
		const wrapper = await mountDashboard();
		data.value = { total: 1, messages: [message('a')] };
		count.value = 1;
		await flushPromises();

		hidePreview.value = true;
		await flushPromises();
		expect(contentWrites().at(-1)).toMatchObject({ unread: 1, messages: [] });

		settings.value = {
			global: { notificationsEnabled: false, showTrayIcon: true, closeToTray: true },
		};
		await flushPromises();
		expect(contentWrites().at(-1)).toMatchObject({ notificationsPaused: true });
		wrapper.unmount();
	});

	it('clears what it reported when the dashboard goes away', async () => {
		const wrapper = await mountDashboard();
		data.value = { total: 1, messages: [message('a')] };
		count.value = 1;
		await flushPromises();

		wrapper.unmount();
		await flushPromises();
		expect(contentWrites().at(-1)).toEqual({
			unread: null,
			messages: [],
			workspaceId: null,
			notificationsPaused: false,
		});
	});

	it('keeps the content when a new dashboard mounts before the old one leaves', async () => {
		const first = await mountDashboard();
		const second = await mountDashboard();
		data.value = { total: 1, messages: [message('a')] };
		count.value = 1;
		await flushPromises();

		first.unmount();
		await flushPromises();
		expect(contentWrites().at(-1)).toMatchObject({ unread: 1 });

		second.unmount();
		await flushPromises();
		expect(contentWrites().at(-1)).toMatchObject({ unread: null });
	});
});

describe('useDesktopTray: the settings', () => {
	it('waits for the stored settings before pushing them', async () => {
		isReady.value = false;
		settings.value = {
			global: { notificationsEnabled: true, showTrayIcon: true, closeToTray: true },
		};
		const wrapper = await mountDashboard();
		expect(native.setTrayPreferences).not.toHaveBeenCalled();

		settings.value = {
			global: { notificationsEnabled: true, showTrayIcon: false, closeToTray: true },
		};
		isReady.value = true;
		await flushPromises();
		expect(native.setTrayPreferences.mock.calls).toEqual([[{ visible: false, closeToTray: true }]]);
		wrapper.unmount();
	});
});

describe('useDesktopTray in the browser', () => {
	it('never touches the tray bridge', async () => {
		isDesktop.value = false;
		const wrapper = await mountDashboard();
		data.value = { total: 1, messages: [message('a')] };
		count.value = 1;
		await flushPromises();
		wrapper.unmount();
		await flushPromises();
		expect(native.updateTray).not.toHaveBeenCalled();
		expect(native.setTrayPreferences).not.toHaveBeenCalled();
	});
});
