import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted spies so the mock factories below can close over them.
const { isPermissionGrantedMock, requestPermissionMock, invokeMock } = vi.hoisted(() => ({
	isPermissionGrantedMock: vi.fn(),
	requestPermissionMock: vi.fn(),
	invokeMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
	isPermissionGranted: () => isPermissionGrantedMock(),
	requestPermission: () => requestPermissionMock(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

import { checkNotificationPermission, requestNotificationPermission } from '../notifications';

beforeEach(() => {
	isPermissionGrantedMock.mockReset();
	requestPermissionMock.mockReset();
	invokeMock.mockReset();
});

describe('checkNotificationPermission', () => {
	it('reports granted without prompting', async () => {
		isPermissionGrantedMock.mockResolvedValue(true);
		await expect(checkNotificationPermission()).resolves.toBe('granted');
		expect(requestPermissionMock).not.toHaveBeenCalled();
	});

	it('reports the recoverable "prompt" for a bare false', async () => {
		// isPermissionGranted() cannot tell "never asked" from "refused"; only a
		// real request can, so the check reports the state we can still act on.
		isPermissionGrantedMock.mockResolvedValue(false);
		await expect(checkNotificationPermission()).resolves.toBe('prompt');
	});

	it('degrades to unavailable outside the Tauri bridge', async () => {
		isPermissionGrantedMock.mockRejectedValue(new Error('no tauri'));
		await expect(checkNotificationPermission()).resolves.toBe('unavailable');
	});
});

describe('requestNotificationPermission', () => {
	it('does not prompt again when permission is already granted', async () => {
		isPermissionGrantedMock.mockResolvedValue(true);
		await expect(requestNotificationPermission()).resolves.toBe('granted');
		expect(requestPermissionMock).not.toHaveBeenCalled();
	});

	it('prompts when undecided and reports the answer', async () => {
		isPermissionGrantedMock.mockResolvedValue(false);
		requestPermissionMock.mockResolvedValue('granted');
		await expect(requestNotificationPermission()).resolves.toBe('granted');
		expect(requestPermissionMock).toHaveBeenCalledTimes(1);
	});

	it('reports a definite refusal as denied', async () => {
		isPermissionGrantedMock.mockResolvedValue(false);
		requestPermissionMock.mockResolvedValue('denied');
		await expect(requestNotificationPermission()).resolves.toBe('denied');
	});

	it('treats a dismissed prompt ("default") as still askable', async () => {
		isPermissionGrantedMock.mockResolvedValue(false);
		requestPermissionMock.mockResolvedValue('default');
		await expect(requestNotificationPermission()).resolves.toBe('prompt');
	});

	it('degrades to unavailable when the plugin throws', async () => {
		isPermissionGrantedMock.mockRejectedValue(new Error('no tauri'));
		await expect(requestNotificationPermission()).resolves.toBe('unavailable');
	});
});
