import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tauri-plugin-store: `load(file)` resolves to a store handle whose
// get/set/save we spy on. Hoisted so the spies exist when the factory runs.
const { loadMock, getMock, setMock, saveMock } = vi.hoisted(() => ({
	loadMock: vi.fn(),
	getMock: vi.fn(),
	setMock: vi.fn(),
	saveMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-store', () => ({
	load: (...args: unknown[]) => loadMock(...args),
}));

import { loadSettingsStore, saveSettingsStore } from '../settings';

beforeEach(() => {
	loadMock.mockReset();
	getMock.mockReset();
	setMock.mockReset();
	saveMock.mockReset();
	loadMock.mockResolvedValue({ get: getMock, set: setMock, save: saveMock });
});

describe('loadSettingsStore', () => {
	it('reads the state key from settings.json', async () => {
		const state = { version: 1, global: { autoCheckUpdates: false } };
		getMock.mockResolvedValue(state);

		await expect(loadSettingsStore()).resolves.toEqual(state);
		expect(loadMock).toHaveBeenCalledWith('settings.json');
		expect(getMock).toHaveBeenCalledWith('state');
	});

	it('returns null when the store has no state yet', async () => {
		getMock.mockResolvedValue(undefined);
		await expect(loadSettingsStore()).resolves.toBeNull();
	});

	it('returns null (never throws) when the store fails to open', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		loadMock.mockRejectedValue(new Error('disk gone'));

		await expect(loadSettingsStore()).resolves.toBeNull();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});

describe('saveSettingsStore', () => {
	it('round-trips: sets the state key then persists', async () => {
		const state = { version: 1, workspaces: { 'ws-1': { muteNotifications: true } } };

		await saveSettingsStore(state);

		expect(setMock).toHaveBeenCalledWith('state', state);
		expect(saveMock).toHaveBeenCalled();
	});

	it('swallows store failures (settings loss is non-fatal)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		saveMock.mockRejectedValue(new Error('readonly fs'));

		await expect(saveSettingsStore({ version: 1 })).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
