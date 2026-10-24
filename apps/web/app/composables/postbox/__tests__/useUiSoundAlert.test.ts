import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ALERT_SOUND_BURST_MS } from '~/lib/alertSoundRules';
import { ALERT_SOUND_DATA_URI } from '~/utils/alertSound';

/**
 * The alert chime: one shared element, one sound per burst across callers and
 * tabs (the stamp in localStorage), autoplay refusals swallowed, and the
 * gesture unlock that must never silence a real alert.
 */
let created: MockAudio[] = [];
let playImpl: () => Promise<void> = () => Promise.resolve();

class MockAudio {
	src: string;
	volume = 1;
	preload = '';
	currentTime = 0;
	muted = false;
	paused = true;
	play = vi.fn(() => {
		this.paused = false;
		return playImpl();
	});
	pause = vi.fn(() => {
		this.paused = true;
	});
	constructor(src?: string) {
		this.src = src ?? '';
		created.push(this);
	}
}

/** Re-import so the module-level element, burst stamp and prime flag reset. */
async function loadSound() {
	vi.resetModules();
	return import('../useUiSound');
}

const STAMP_KEY = 'owlat:alert-sound-at';

beforeEach(() => {
	created = [];
	playImpl = () => Promise.resolve();
	localStorage.clear();
	vi.stubGlobal('Audio', MockAudio as unknown as typeof Audio);
});

afterEach(() => {
	// Not vi.unstubAllGlobals(): it would also clear the Vue auto-import globals
	// installed by the shared setup file. Audio is re-stubbed in beforeEach.
	vi.restoreAllMocks();
});

describe('playAlertSound', () => {
	it('plays the alert chime, not the send sound, at a soft volume', async () => {
		const { playAlertSound } = await loadSound();

		expect(playAlertSound(1_000)).toBe(true);

		expect(created).toHaveLength(1);
		expect(created[0]!.src).toBe(ALERT_SOUND_DATA_URI);
		expect(created[0]!.volume).toBeCloseTo(0.5);
		expect(created[0]!.play).toHaveBeenCalledTimes(1);
	});

	it('makes one sound per burst, shared by every caller', async () => {
		const { playAlertSound } = await loadSound();

		expect(playAlertSound(1_000)).toBe(true);
		expect(playAlertSound(1_000 + ALERT_SOUND_BURST_MS - 1)).toBe(false);
		expect(created).toHaveLength(1);
		expect(created[0]!.play).toHaveBeenCalledTimes(1);

		expect(playAlertSound(1_000 + ALERT_SOUND_BURST_MS)).toBe(true);
		expect(created[0]!.play).toHaveBeenCalledTimes(2);
	});

	it('stays quiet when another tab sounded within the window', async () => {
		localStorage.setItem(STAMP_KEY, '5000');
		const { playAlertSound } = await loadSound();

		expect(playAlertSound(5_000 + ALERT_SOUND_BURST_MS - 1)).toBe(false);
		expect(created[0]?.play ?? vi.fn()).not.toHaveBeenCalled();
		expect(playAlertSound(5_000 + ALERT_SOUND_BURST_MS)).toBe(true);
		expect(localStorage.getItem(STAMP_KEY)).toBe(String(5_000 + ALERT_SOUND_BURST_MS));
	});

	it('ignores an unreadable stamp from storage', async () => {
		localStorage.setItem(STAMP_KEY, 'not-a-number');
		const { playAlertSound } = await loadSound();

		expect(playAlertSound(1_000)).toBe(true);
	});

	it('plays in a hidden tab, unlike the send sound', async () => {
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
		const { playAlertSound } = await loadSound();

		expect(playAlertSound(1_000)).toBe(true);
		expect(created[0]!.play).toHaveBeenCalledTimes(1);
	});

	it('swallows an autoplay refusal, and the refused burst stays quiet', async () => {
		playImpl = () => Promise.reject(new Error('autoplay blocked'));
		const { playAlertSound } = await loadSound();

		expect(() => playAlertSound(1_000)).not.toThrow();
		await Promise.resolve();
		await Promise.resolve();
		expect(playAlertSound(1_001)).toBe(false);
		expect(created[0]!.play).toHaveBeenCalledTimes(1);
	});

	it('is a no-op where there is no Audio (server render)', async () => {
		vi.stubGlobal('Audio', undefined);
		const { playAlertSound } = await loadSound();

		expect(playAlertSound(1_000)).toBe(false);
		expect(localStorage.getItem(STAMP_KEY)).toBeNull();
	});
});

describe('primeAlertSound', () => {
	it('plays the element muted and stops it again, once', async () => {
		const { primeAlertSound } = await loadSound();

		primeAlertSound();
		const audio = created[0]!;
		expect(audio.play).toHaveBeenCalledTimes(1);
		expect(audio.muted).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(audio.pause).toHaveBeenCalledTimes(1);
		expect(audio.muted).toBe(false);

		primeAlertSound();
		expect(audio.play).toHaveBeenCalledTimes(1);
	});

	it('leaves a real alert that started during the unlock playing, audibly', async () => {
		const { primeAlertSound, playAlertSound } = await loadSound();

		primeAlertSound();
		playAlertSound(1_000);
		await Promise.resolve();
		await Promise.resolve();

		const audio = created[0]!;
		expect(audio.muted).toBe(false);
		expect(audio.pause).not.toHaveBeenCalled();
	});

	it('does not touch an alert that is already sounding', async () => {
		const { primeAlertSound, playAlertSound } = await loadSound();

		playAlertSound(1_000);
		primeAlertSound();

		const audio = created[0]!;
		expect(audio.play).toHaveBeenCalledTimes(1);
		expect(audio.muted).toBe(false);
	});

	it('tries again on the next gesture when the unlock is refused', async () => {
		playImpl = () => Promise.reject(new Error('not allowed'));
		const { primeAlertSound } = await loadSound();

		primeAlertSound();
		await Promise.resolve();
		await Promise.resolve();
		const audio = created[0]!;
		expect(audio.muted).toBe(false);

		audio.paused = true;
		primeAlertSound();
		expect(audio.play).toHaveBeenCalledTimes(2);
	});
});

describe('previewAlertSound', () => {
	it('plays audibly without opening a burst', async () => {
		const { previewAlertSound, playAlertSound } = await loadSound();

		previewAlertSound();
		const audio = created[0]!;
		expect(audio.play).toHaveBeenCalledTimes(1);
		expect(audio.muted).toBe(false);
		expect(localStorage.getItem(STAMP_KEY)).toBeNull();

		expect(playAlertSound(1_000)).toBe(true);
		expect(audio.play).toHaveBeenCalledTimes(2);
	});
});
