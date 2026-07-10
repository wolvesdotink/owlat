import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri core bridge: invoke is a spy so we can assert the command name
// and payload the bridge forwards. invokeMock is declared via vi.hoisted so it
// exists when the hoisted vi.mock factory runs.
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

// The window-controls half of window.ts (startDragging, applyVibrancy, …) pulls
// in '@tauri-apps/api/window', which is not needed for these bridge assertions.
vi.mock('@tauri-apps/api/window', () => ({
	getCurrentWindow: () => ({}),
	Effect: { Mica: 'mica', Sidebar: 'sidebar' },
}));

import { setTrafficLightsVisible } from '../window';

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(undefined);
});

describe('setTrafficLightsVisible bridge', () => {
	it('invokes set_traffic_lights_visible with visible=true when shown', async () => {
		await setTrafficLightsVisible(true);
		expect(invokeMock).toHaveBeenCalledWith('set_traffic_lights_visible', { visible: true });
	});

	it('invokes set_traffic_lights_visible with visible=false when hidden', async () => {
		await setTrafficLightsVisible(false);
		expect(invokeMock).toHaveBeenCalledWith('set_traffic_lights_visible', { visible: false });
	});

	it('maps the sidebar/peek state to visibility (hidden ↔ shown)', async () => {
		// Mirrors the layout rule: shown = !effectiveHidden || isPeeking.
		const lightsVisible = (hidden: boolean, peeking: boolean) => !hidden || peeking;

		await setTrafficLightsVisible(lightsVisible(false, false)); // visible sidebar
		await setTrafficLightsVisible(lightsVisible(true, false)); // hidden, no peek
		await setTrafficLightsVisible(lightsVisible(true, true)); // hidden but peeking

		expect(invokeMock.mock.calls.map((c) => (c[1] as { visible: boolean }).visible)).toEqual([
			true,
			false,
			true,
		]);
	});
});
