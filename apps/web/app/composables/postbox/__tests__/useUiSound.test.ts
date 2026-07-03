import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * A stand-in for the DOM `Audio` element that records construction and play
 * calls. The composable holds a single shared instance, so `created` lets us
 * assert the singleton behavior too.
 */
let created: MockAudio[] = [];
let playImpl: () => Promise<void> = () => Promise.resolve();

class MockAudio {
	src: string;
	volume = 1;
	preload = '';
	currentTime = 0;
	play = vi.fn(() => playImpl());
	constructor(src?: string) {
		this.src = src ?? '';
		created.push(this);
	}
}

/** Re-import the composable fresh so its module-level singleton resets. */
async function loadUseUiSound() {
	vi.resetModules();
	const mod = await import('../useUiSound');
	return mod.useUiSound;
}

beforeEach(() => {
	created = [];
	playImpl = () => Promise.resolve();
	vi.stubGlobal('Audio', MockAudio as unknown as typeof Audio);
});

afterEach(() => {
	// Note: don't call vi.unstubAllGlobals() here — it would also clear the Vue
	// auto-import globals installed once by the shared setup file. Audio is
	// re-stubbed in beforeEach, and spies are restored below.
	vi.restoreAllMocks();
});

describe('useUiSound', () => {
	it('does not play when disabled (never constructs Audio)', async () => {
		const useUiSound = await loadUseUiSound();
		const { playSend } = useUiSound(false);

		playSend();

		expect(created).toHaveLength(0);
	});

	it('plays once per send event when enabled, reusing one shared Audio', async () => {
		const useUiSound = await loadUseUiSound();
		const { playSend } = useUiSound(true);

		playSend();
		playSend();

		// A single shared element, played once per call.
		expect(created).toHaveLength(1);
		expect(created[0]!.play).toHaveBeenCalledTimes(2);
		// Volume is kept low for a subtle confirmation.
		expect(created[0]!.volume).toBeCloseTo(0.4);
	});

	it('reflects a reactive/getter enabled flag at call time', async () => {
		const useUiSound = await loadUseUiSound();
		const enabled = ref(false);
		const { playSend } = useUiSound(enabled);

		playSend();
		expect(created).toHaveLength(0);

		enabled.value = true;
		playSend();
		expect(created).toHaveLength(1);
		expect(created[0]!.play).toHaveBeenCalledTimes(1);
	});

	it('swallows autoplay-policy rejections silently', async () => {
		playImpl = () => Promise.reject(new Error('autoplay blocked'));
		const useUiSound = await loadUseUiSound();
		const { playSend } = useUiSound(true);

		expect(() => playSend()).not.toThrow();
		// Let the rejected promise settle; the internal .catch must handle it so
		// no unhandled rejection escapes.
		await Promise.resolve();
		await Promise.resolve();
		expect(created[0]!.play).toHaveBeenCalledTimes(1);
	});

	it('does not play while the tab is hidden', async () => {
		const hiddenSpy = vi
			.spyOn(document, 'hidden', 'get')
			.mockReturnValue(true);
		const useUiSound = await loadUseUiSound();
		const { playSend } = useUiSound(true);

		playSend();

		expect(created).toHaveLength(0);
		hiddenSpy.mockRestore();
	});
});
