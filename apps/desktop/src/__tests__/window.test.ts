import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Tauri core bridge: invoke is a spy so we can assert the command name
// and payload the bridge forwards. invokeMock is declared via vi.hoisted so it
// exists when the hoisted vi.mock factory runs.
const { invokeMock, setTitleMock, setThemeMock } = vi.hoisted(() => ({
	invokeMock: vi.fn(),
	setTitleMock: vi.fn(),
	setThemeMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: (...args: unknown[]) => invokeMock(...args),
}));

// The window half of window.ts pulls in '@tauri-apps/api/window'; only the
// title/theme setters are needed for these bridge assertions.
vi.mock('@tauri-apps/api/window', () => ({
	getCurrentWindow: () => ({ setTitle: setTitleMock, setTheme: setThemeMock }),
	Effect: { Mica: 'mica', Sidebar: 'sidebar' },
}));

import {
	setAccentFrame,
	setAccentFrameVisible,
	setTrafficLightsVisible,
	setWindowTheme,
	setWindowTitle,
	trafficLightsVisibleFor,
	windowTitleFor,
} from '../window';

beforeEach(() => {
	invokeMock.mockReset();
	invokeMock.mockResolvedValue(undefined);
	setTitleMock.mockReset();
	setTitleMock.mockResolvedValue(undefined);
	setThemeMock.mockReset();
	setThemeMock.mockResolvedValue(undefined);
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

	it('maps the sidebar/peek state to visibility via the shared production mapping', async () => {
		// Assert against the real exported mapping the layout consumes, so this
		// stays protective if that rule ever changes (no local re-derivation).
		await setTrafficLightsVisible(trafficLightsVisibleFor(false, false)); // visible sidebar
		await setTrafficLightsVisible(trafficLightsVisibleFor(true, false)); // hidden, no peek
		await setTrafficLightsVisible(trafficLightsVisibleFor(true, true)); // hidden but peeking

		expect(invokeMock.mock.calls.map((c) => (c[1] as { visible: boolean }).visible)).toEqual([
			true,
			false,
			true,
		]);
	});
});

describe('windowTitleFor mapping', () => {
	it('uses the bare workspace label on macOS (the menu bar already names the app)', () => {
		expect(windowTitleFor('Acme', true)).toBe('Acme');
	});

	it('qualifies the app name with the workspace on Windows/Linux (taskbar surfaces)', () => {
		expect(windowTitleFor('Acme', false)).toBe('Acme — Owlat');
	});

	it('falls back to the plain app name when no workspace is connected', () => {
		expect(windowTitleFor(null, true)).toBe('Owlat');
		expect(windowTitleFor(null, false)).toBe('Owlat');
	});
});

describe('setWindowTitle / setWindowTheme bridges', () => {
	it('forwards the title to the native window', async () => {
		await setWindowTitle('Acme');
		expect(setTitleMock).toHaveBeenCalledWith('Acme');
	});

	it('pins the native chrome to the app theme and follows the OS on null', async () => {
		await setWindowTheme('dark');
		await setWindowTheme(null);
		expect(setThemeMock.mock.calls).toEqual([['dark'], [null]]);
	});
});

describe('setAccentFrame / setAccentFrameVisible bridges', () => {
	it('paints the native ring visible when given an accent', async () => {
		await setAccentFrame('#7c9c67');
		expect(invokeMock).toHaveBeenCalledWith('set_accent_frame', {
			color: '#7c9c67',
			visible: true,
		});
	});

	it('hides the ring when the accent is cleared', async () => {
		await setAccentFrame(null);
		expect(invokeMock).toHaveBeenCalledWith('set_accent_frame', { color: null, visible: false });
	});

	it('toggles visibility without touching the color (fullscreen choreography)', async () => {
		await setAccentFrameVisible(false);
		await setAccentFrameVisible(true);
		expect(invokeMock.mock.calls).toEqual([
			['set_accent_frame', { color: null, visible: false }],
			['set_accent_frame', { color: null, visible: true }],
		]);
	});
});

describe('trafficLightsVisibleFor mapping', () => {
	it('shows the lights whenever the sidebar rail is visible', () => {
		expect(trafficLightsVisibleFor(false, false)).toBe(true);
		expect(trafficLightsVisibleFor(false, true)).toBe(true);
	});

	it('hides the lights only when the rail is hidden and not peeking', () => {
		expect(trafficLightsVisibleFor(true, false)).toBe(false);
	});

	it('shows the lights when the rail is hidden but the peek overlay is open', () => {
		expect(trafficLightsVisibleFor(true, true)).toBe(true);
	});
});
