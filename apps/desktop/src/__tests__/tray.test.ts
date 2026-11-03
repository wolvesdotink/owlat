import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, listenMock } = vi.hoisted(() => ({
	invokeMock: vi.fn(),
	listenMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listenMock(...args) }));

import { onTrayToggleNotifications, setTrayPreferences, updateTray } from '../tray';

beforeEach(() => {
	invokeMock.mockReset();
	listenMock.mockReset();
});

describe('updateTray', () => {
	it('sends the content in the shape the Rust command takes', async () => {
		invokeMock.mockResolvedValue(undefined);
		await updateTray({
			unread: 3.4,
			messages: [{ messageId: 'm1', sender: 'Ada', subject: 'Hi' }],
			workspaceId: 'ws-1',
			notificationsPaused: true,
		});
		expect(invokeMock).toHaveBeenCalledWith('update_tray', {
			unread: 3,
			messages: [{ messageId: 'm1', sender: 'Ada', subject: 'Hi' }],
			workspaceId: 'ws-1',
			notificationsPaused: true,
		});
	});

	it('passes an unknown count through as null and never sends a negative one', async () => {
		invokeMock.mockResolvedValue(undefined);
		const base = { messages: [], workspaceId: null, notificationsPaused: false };
		await updateTray({ ...base, unread: null });
		await updateTray({ ...base, unread: -2 });
		expect(invokeMock.mock.calls.map(([, args]) => args.unread)).toEqual([null, 0]);
	});

	it('swallows a failed call', async () => {
		invokeMock.mockRejectedValue(new Error('no tauri'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await expect(
			updateTray({ unread: 1, messages: [], workspaceId: null, notificationsPaused: false })
		).resolves.toBeUndefined();
		warn.mockRestore();
	});
});

describe('setTrayPreferences', () => {
	it('sends both switches', async () => {
		invokeMock.mockResolvedValue(undefined);
		await setTrayPreferences({ visible: false, closeToTray: true });
		expect(invokeMock).toHaveBeenCalledWith('set_tray_preferences', {
			visible: false,
			closeToTray: true,
		});
	});
});

describe('onTrayToggleNotifications', () => {
	it('listens for the event the Rust tray emits', async () => {
		const unlisten = vi.fn();
		listenMock.mockResolvedValue(unlisten);
		const cb = vi.fn();
		await expect(onTrayToggleNotifications(cb)).resolves.toBe(unlisten);
		expect(listenMock).toHaveBeenCalledWith('tray://toggle-notifications', expect.any(Function));
		listenMock.mock.calls[0]![1]();
		expect(cb).toHaveBeenCalledTimes(1);
	});
});
