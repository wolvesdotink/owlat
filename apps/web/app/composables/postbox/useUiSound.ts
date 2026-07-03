/**
 * Tiny UI-sound primitive for the Postbox send confirmation.
 *
 * Deliberately minimal and unintrusive:
 *   - A single shared `Audio` element (module-level singleton) is created
 *     lazily on first use and reused for every play, so we never accumulate
 *     audio elements.
 *   - Volume is capped low (~0.4) — a soft confirmation, not a chime.
 *   - Never plays while the tab is hidden (`document.hidden`).
 *   - Autoplay-policy rejections (the browser blocking sound until the user
 *     has interacted) are swallowed silently: the sound is a non-essential
 *     nicety and must never surface an error.
 *
 * Gating is passed in: `playSend` is a no-op unless `enabled` resolves truthy,
 * so the caller wires it to the (default-off) "Play sound when sending"
 * preference. AI/sanitizer rules do not apply — this touches no mail content.
 */

import { POSTBOX_SEND_SOUND_DATA_URI } from '~/utils/postboxSendSound';

// Reduced volume so the confirmation stays subtle.
const SEND_SOUND_VOLUME = 0.4;

// Shared across every caller: one Audio element for the whole app session.
let sharedAudio: HTMLAudioElement | null = null;

function getSendAudio(): HTMLAudioElement | null {
	// `typeof Audio` is undefined during SSR, so this is inherently no-op on the
	// server without needing an explicit client guard.
	if (typeof Audio === 'undefined') return null;
	if (!sharedAudio) {
		sharedAudio = new Audio(POSTBOX_SEND_SOUND_DATA_URI);
		sharedAudio.volume = SEND_SOUND_VOLUME;
		sharedAudio.preload = 'auto';
	}
	return sharedAudio;
}

export function useUiSound(enabled: MaybeRefOrGetter<boolean>) {
	/**
	 * Play the send-confirmation sound once, if enabled and the tab is visible.
	 * Safe to call from any environment: it no-ops server-side and swallows
	 * both synchronous throws and the async autoplay-policy rejection.
	 */
	function playSend() {
		if (!toValue(enabled)) return;
		// Don't intrude when the user isn't looking at the tab.
		if (typeof document !== 'undefined' && document.hidden) return;
		const audio = getSendAudio();
		if (!audio) return;
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

	return { playSend };
}
