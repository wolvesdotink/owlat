/**
 * Tiny UI-sound primitives: the Postbox send confirmation and the opt-in
 * alert chime.
 *
 * Deliberately minimal and unintrusive:
 *   - One shared `Audio` element per sound (module-level singletons), created
 *     lazily on first use and reused for every play, so we never accumulate
 *     audio elements.
 *   - Volume is capped low — a soft cue, not a ringtone.
 *   - Autoplay-policy rejections (the browser blocking sound until the user
 *     has interacted) are swallowed silently: a sound is a non-essential
 *     nicety and must never surface an error.
 *
 * The send sound never plays while the tab is hidden: it confirms something
 * the user just did in front of it. The alert chime does play in a hidden tab
 * or a background window, because that is when an alert is worth hearing; it
 * is rationed instead, one per burst across every tab of this origin.
 *
 * Gating is passed in: `playSend` is a no-op unless `enabled` resolves truthy,
 * so the caller wires it to the (default-off) "Play sound when sending"
 * preference, and `playAlertSound` is only reached once the alert rules
 * (`lib/alertSoundRules`) said yes. AI/sanitizer rules do not apply — this
 * touches no mail content.
 *
 * The sounds themselves are base64 WAV data URIs, which gzip cannot shrink, and
 * both are off by default, so they are imported on first use instead of riding
 * every dashboard page: when the preference is on (`useUiSound`, `useAlertSounds`
 * and the alert switches load them ahead), or at the first play. A play that
 * comes before its sound has loaded starts once it has.
 */

import { watch } from 'vue';
import { isNewAlertBurst } from '~/lib/alertSoundRules';

/** One data URI, imported once; a failed import is forgotten so the next use retries. */
function lazySound(load: () => Promise<string>) {
	let uri: string | null = null;
	let pending: Promise<void> | null = null;
	return {
		get: (): string | null => uri,
		load(): Promise<void> {
			// No `Audio` (server render): nothing could play it.
			if (typeof Audio === 'undefined') return Promise.resolve();
			pending ??= load().then(
				(value) => {
					uri = value;
				},
				() => {
					pending = null;
				}
			);
			return pending;
		},
	};
}

const sendSound = lazySound(() =>
	import('~/utils/postboxSendSound').then((m) => m.POSTBOX_SEND_SOUND_DATA_URI)
);
const alertSound = lazySound(() =>
	import('~/utils/alertSound').then((m) => m.ALERT_SOUND_DATA_URI)
);

/** Fetch the alert chime ahead of the first alert, so that one plays on time. */
export function loadAlertSound(): Promise<void> {
	return alertSound.load();
}

/** Fetch the send sound; `useUiSound` does this once its preference is on. */
export function loadSendSound(): Promise<void> {
	return sendSound.load();
}

// Reduced volume so the confirmation stays subtle.
const SEND_SOUND_VOLUME = 0.4;

// Shared across every caller: one Audio element for the whole app session.
let sharedAudio: HTMLAudioElement | null = null;

function getSendAudio(): HTMLAudioElement | null {
	// `typeof Audio` is undefined during SSR, so this is inherently no-op on the
	// server without needing an explicit client guard.
	if (typeof Audio === 'undefined') return null;
	const uri = sendSound.get();
	if (uri === null) return null;
	if (!sharedAudio) {
		sharedAudio = new Audio(uri);
		sharedAudio.volume = SEND_SOUND_VOLUME;
		sharedAudio.preload = 'auto';
	}
	return sharedAudio;
}

/**
 * Rewind and play. Swallows both a synchronous throw (some environments) and
 * the async autoplay-policy rejection: a sound must never surface an error.
 */
function startFromTop(audio: HTMLAudioElement): void {
	try {
		audio.currentTime = 0;
		const played = audio.play();
		if (played && typeof played.catch === 'function') {
			played.catch(() => {
				/* autoplay policy blocked it — ignore */
			});
		}
	} catch {
		/* some environments throw synchronously — ignore */
	}
}

/** Don't intrude when the user isn't looking at the tab. */
function tabHidden(): boolean {
	return typeof document !== 'undefined' && document.hidden;
}

export function useUiSound(enabled: MaybeRefOrGetter<boolean>) {
	// Loaded as soon as the preference is on, so the first send sounds on time.
	watch(
		() => toValue(enabled),
		(on) => {
			if (on) void loadSendSound();
		},
		{ immediate: true }
	);

	/**
	 * Play the send-confirmation sound once, if enabled and the tab is visible.
	 * Safe to call from any environment: it no-ops server-side and swallows
	 * both synchronous throws and the async autoplay-policy rejection.
	 */
	function playSend() {
		if (!toValue(enabled) || tabHidden() || typeof Audio === 'undefined') return;
		const audio = getSendAudio();
		if (audio) {
			startFromTop(audio);
			return;
		}
		void sendSound.load().then(() => {
			const loaded = tabHidden() ? null : getSendAudio();
			if (loaded) startFromTop(loaded);
		});
	}

	return { playSend };
}

// A notch above the send sound: it has to be noticed from another window.
const ALERT_SOUND_VOLUME = 0.5;

/**
 * When the last alert chime started, shared by every tab of this origin, so
 * two open tabs (or windows) receiving the same delivery make one sound.
 * Best effort: two tabs reading the stamp in the same instant can both play.
 */
const ALERT_STAMP_KEY = 'owlat:alert-sound-at';

let alertAudio: HTMLAudioElement | null = null;
let lastAlertAt: number | null = null;
let alertPrimed = false;

function getAlertAudio(): HTMLAudioElement | null {
	if (typeof Audio === 'undefined') return null;
	const uri = alertSound.get();
	if (uri === null) return null;
	if (!alertAudio) {
		alertAudio = new Audio(uri);
		alertAudio.volume = ALERT_SOUND_VOLUME;
		alertAudio.preload = 'auto';
	}
	return alertAudio;
}

function readSharedStamp(): number | null {
	try {
		const raw = localStorage.getItem(ALERT_STAMP_KEY);
		const at = raw === null ? Number.NaN : Number(raw);
		return Number.isFinite(at) ? at : null;
	} catch {
		return null;
	}
}

/** Take the burst slot at `now`, or report that a burst is already sounding. */
function claimAlertBurst(now: number): boolean {
	if (!isNewAlertBurst(lastAlertAt, now) || !isNewAlertBurst(readSharedStamp(), now)) {
		return false;
	}
	lastAlertAt = now;
	try {
		localStorage.setItem(ALERT_STAMP_KEY, String(now));
	} catch {
		/* storage unavailable (private mode, quota) — this tab still rations itself */
	}
	return true;
}

/**
 * Play the alert chime unless another alert sounded within the burst window,
 * here or in another tab. Returns whether this call claimed the burst. A play
 * the browser refuses (no user interaction yet) is swallowed and still counts:
 * the burst it would have opened stays quiet rather than retrying per arrival.
 */
export function playAlertSound(now: number = Date.now()): boolean {
	if (typeof Audio === 'undefined' || !claimAlertBurst(now)) return false;
	const audio = getAlertAudio();
	if (audio) soundAlert(audio);
	else void alertSound.load().then(() => withAlertAudio(soundAlert));
	return true;
}

function soundAlert(audio: HTMLAudioElement): void {
	// Un-muting first is what tells a pending prime (below) not to pause us.
	audio.muted = false;
	startFromTop(audio);
}

function withAlertAudio(use: (audio: HTMLAudioElement) => void): void {
	const audio = getAlertAudio();
	if (audio) use(audio);
}

/**
 * Unlock the alert element from inside a user gesture. WebKit (Safari, and
 * the desktop app's webview on macOS) only lets an element play on its own
 * once it has played in response to a gesture, and an alert never arrives
 * inside one. So the first click or key press plays the element muted and
 * stops it again. A real alert that starts meanwhile un-mutes the element,
 * and the prime then leaves it playing.
 *
 * The unlock only counts inside the gesture, so a chime that has not loaded
 * yet is fetched now and unlocked by the next gesture.
 */
export function primeAlertSound(): void {
	if (alertPrimed) return;
	const audio = getAlertAudio();
	if (!audio) {
		void alertSound.load();
		return;
	}
	alertPrimed = true;
	// Already sounding: it could play, so it is unlocked, and muting it now
	// would silence a real alert mid-chime.
	if (!audio.paused) return;
	const release = () => {
		audio.muted = false;
		alertPrimed = false;
	};
	try {
		audio.muted = true;
		const played = audio.play();
		if (!played || typeof played.then !== 'function') {
			audio.pause();
			audio.muted = false;
			return;
		}
		played.then(() => {
			if (!audio.muted) return;
			audio.pause();
			audio.currentTime = 0;
			audio.muted = false;
		}, release);
	} catch {
		release();
	}
}

/**
 * Play the chime once so the user hears what they just switched on. Called
 * from the switch's own click, so it also unlocks the element for later
 * alerts; it opens no burst, so a real alert a moment later still sounds.
 * A chime that has not loaded yet plays once it has, outside the click, so it
 * does not count as the unlock and the next gesture still primes it.
 */
export function previewAlertSound(): void {
	const audio = getAlertAudio();
	if (!audio) {
		void alertSound.load().then(() => withAlertAudio(soundAlert));
		return;
	}
	alertPrimed = true;
	soundAlert(audio);
}
