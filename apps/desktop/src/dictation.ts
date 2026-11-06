/**
 * On-device dictation through the native shell (src-tauri/src/dictation.rs):
 * the macOS Speech framework with on-device recognition required. Windows and
 * Linux report it unavailable.
 *
 * One session at a time, app-wide: starting one ends the one before, which
 * then hears `end`. Stop and cancel take the id `dictationStart` resolved
 * with, so they never touch a session another window started since.
 */
import { Channel, invoke } from '@tauri-apps/api/core';

/** Why a session stopped early. */
export type NativeDictationError = 'blocked' | 'no-speech' | 'language' | 'failed';

/** What a session reports, in order: partials and phrases, maybe an error, then `end`. */
export type NativeDictationEvent =
	/** The phrase still being heard. */
	| { kind: 'partial'; text: string }
	/** A finished phrase. */
	| { kind: 'phrase'; text: string }
	| { kind: 'error'; reason: NativeDictationError }
	| { kind: 'end' };

/** Whether `lang` (a BCP 47 tag) can be dictated without the audio leaving this device. */
export function dictationAvailable(lang: string): Promise<boolean> {
	return invoke<boolean>('dictation_available', { lang });
}

/**
 * Start listening in `lang`. The permission prompts, the first time, come
 * after this resolves; a refusal arrives as a `blocked` error.
 */
export function dictationStart(
	lang: string,
	onEvent: (event: NativeDictationEvent) => void
): Promise<number> {
	return invoke<number>('dictation_start', { lang, onEvent: new Channel(onEvent) });
}

/** Stop listening; what was heard still arrives, then `end`. */
export function dictationStop(session: number): Promise<void> {
	return invoke('dictation_stop', { session });
}

/** Stop listening and drop what was not delivered yet. */
export function dictationCancel(session: number): Promise<void> {
	return invoke('dictation_cancel', { session });
}
