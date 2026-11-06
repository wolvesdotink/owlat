/**
 * Speech to text, one finished phrase at a time.
 *
 * Owlat never receives or stores audio: the engine belongs to the browser or
 * the desktop app, and only its text reaches the page. In a browser it is the
 * Web Speech API. Where that engine can run on this device for the language
 * (Chromium's `processLocally`) it is asked to, and `onDevice` says so.
 * Otherwise the browser's own speech service hears the audio, which for most
 * browsers means a cloud service, and the UI has to say that.
 *
 * The desktop app offers dictation only on-device. Its macOS webview has no
 * on-device mode, so there the shell's own engine (the Speech framework with
 * on-device recognition required, `@owlat/desktop/src/dictation`) does the
 * work. Where the shell has no engine for the language, a webview engine that
 * can run on-device is used, and otherwise the mic stays hidden.
 *
 * Hidden, not broken: `available` stays false until a mounted check finds an
 * engine (never during SSR, so server and client markup agree).
 */
import { onMounted, onScopeDispose, readonly, ref } from 'vue';
import type * as DictationBridge from '@owlat/desktop/src/dictation';
import type { NativeDictationEvent } from '@owlat/desktop/src/dictation';
import { useDesktopContext } from '~/composables/useDesktopContext';

interface RecognitionAlternative {
	transcript: string;
}
interface RecognitionResult {
	readonly isFinal: boolean;
	readonly [index: number]: RecognitionAlternative;
}
interface RecognitionResultEvent extends Event {
	resultIndex: number;
	results: ArrayLike<RecognitionResult>;
}
interface RecognitionErrorEvent extends Event {
	error: string;
}
/** Fires `result`, `error` and `end`. */
interface Recognition extends EventTarget {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	processLocally?: boolean;
	start(): void;
	stop(): void;
	abort(): void;
}
interface RecognitionConstructor {
	new (): Recognition;
	available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

/** Why listening stopped early, in the terms the UI explains. */
export type DictationError = 'blocked' | 'no-speech' | 'network' | 'language' | 'failed';

const ERRORS: Record<string, DictationError> = {
	'not-allowed': 'blocked',
	'service-not-allowed': 'blocked',
	'audio-capture': 'blocked',
	'no-speech': 'no-speech',
	network: 'network',
	'language-not-supported': 'language',
};

const NATIVE_ERRORS: Record<string, DictationError> = {
	blocked: 'blocked',
	'no-speech': 'no-speech',
	language: 'language',
};

type NativeBridge = typeof DictationBridge;

/** The desktop shell's engine, if it can dictate `lang` on-device. An older shell has no such command. */
async function nativeOnDevice(lang: string): Promise<NativeBridge | null> {
	try {
		const bridge = await import('@owlat/desktop/src/dictation');
		return (await bridge.dictationAvailable(lang)) === true ? bridge : null;
	} catch {
		return null;
	}
}

/** One run of the shell's engine; `id` arrives once the shell has started it. */
interface NativeSession {
	id: number | null;
	/** Cancelled before the shell said which session it started. */
	cancelled: boolean;
}

function recognitionConstructor(): RecognitionConstructor | null {
	if (typeof window === 'undefined') return null;
	const w = window as unknown as {
		SpeechRecognition?: RecognitionConstructor;
		webkitSpeechRecognition?: RecognitionConstructor;
	};
	return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Whether the engine can turn `lang` into text without leaving this device. */
async function canRunOnDevice(Ctor: RecognitionConstructor, lang: string): Promise<boolean> {
	if (typeof Ctor.available !== 'function' || !('processLocally' in Ctor.prototype)) return false;
	try {
		return (await Ctor.available({ langs: [lang], processLocally: true })) === 'available';
	} catch {
		return false;
	}
}

export function useSpeechDictation(opts: {
	/** A finished phrase, as the engine wrote it. */
	onPhrase: (phrase: string) => void;
}) {
	const { isDesktop } = useDesktopContext();
	const available = ref(false);
	const onDevice = ref(false);
	const listening = ref(false);
	/** The phrase being heard, not yet final; shown, never inserted. */
	const interim = ref('');
	const error = ref<DictationError | null>(null);
	let recognition: Recognition | null = null;
	/** Set when the desktop shell's engine is the one in use. */
	let native: NativeBridge | null = null;
	let session: NativeSession | null = null;
	let disposed = false;

	// The language people speak most often matches their browser's, not the
	// UI's (Owlat has two). A transcript goes in as spoken, never translated.
	const lang = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

	onMounted(async () => {
		const shell = isDesktop.value ? await nativeOnDevice(lang()) : null;
		if (disposed) return;
		if (shell) {
			native = shell;
			onDevice.value = true;
			available.value = true;
			return;
		}
		const Ctor = recognitionConstructor();
		if (!Ctor || disposed) return;
		const local = await canRunOnDevice(Ctor, lang());
		if (disposed) return;
		onDevice.value = local;
		available.value = local || !isDesktop.value;
	});

	function finishNative(run: NativeSession) {
		if (run !== session) return;
		session = null;
		listening.value = false;
		interim.value = '';
	}

	function heardNative(run: NativeSession, event: NativeDictationEvent) {
		if (run !== session) return;
		if (event.kind === 'partial') interim.value = event.text.trim();
		else if (event.kind === 'phrase') {
			interim.value = '';
			if (event.text.trim()) opts.onPhrase(event.text);
		} else if (event.kind === 'error') error.value = NATIVE_ERRORS[event.reason] ?? 'failed';
		else finishNative(run);
	}

	function startNative(shell: NativeBridge) {
		if (session) return;
		const run: NativeSession = { id: null, cancelled: false };
		session = run;
		error.value = null;
		interim.value = '';
		listening.value = true;
		shell
			.dictationStart(lang(), (event) => heardNative(run, event))
			.then((id) => {
				run.id = id;
				if (run.cancelled) cancelNativeRun(shell, id);
			})
			.catch(() => {
				if (run !== session) return;
				error.value = 'failed';
				finishNative(run);
			});
	}

	function cancelNativeRun(shell: NativeBridge, id: number) {
		// A rejection means the shell had already ended it.
		shell.dictationCancel(id).catch(() => {});
	}

	function start() {
		if (native) {
			startNative(native);
			return;
		}
		const Ctor = recognitionConstructor();
		if (!Ctor || !available.value || recognition) return;
		const rec = new Ctor();
		rec.lang = lang();
		rec.continuous = true;
		rec.interimResults = true;
		if (onDevice.value) rec.processLocally = true;
		rec.addEventListener('result', (event) => {
			if (rec !== recognition) return;
			const { resultIndex, results } = event as RecognitionResultEvent;
			let pending = '';
			for (let i = resultIndex; i < results.length; i++) {
				const result = results[i];
				const text = result?.[0]?.transcript ?? '';
				if (result?.isFinal) {
					if (text.trim()) opts.onPhrase(text);
				} else pending += text;
			}
			interim.value = pending.trim();
		});
		rec.addEventListener('error', (event) => {
			const reason = (event as RecognitionErrorEvent).error;
			// `aborted` is our own cancel.
			if (rec !== recognition || reason === 'aborted') return;
			error.value = ERRORS[reason] ?? 'failed';
		});
		rec.addEventListener('end', () => {
			if (rec !== recognition) return;
			recognition = null;
			listening.value = false;
			interim.value = '';
		});
		error.value = null;
		interim.value = '';
		recognition = rec;
		try {
			rec.start();
			listening.value = true;
		} catch {
			recognition = null;
			error.value = 'failed';
		}
	}

	/** Stop listening; the phrase being heard still finishes and goes in. */
	function stop() {
		const run = session;
		if (native && run) {
			// Not started yet: nothing was heard, so stopping is cancelling.
			if (run.id === null) cancel();
			else native.dictationStop(run.id).catch(() => finishNative(run));
			return;
		}
		recognition?.stop();
	}

	/** Stop listening and drop the phrase being heard. Phrases already in stay. */
	function cancel() {
		const run = session;
		if (native && run) {
			finishNative(run);
			run.cancelled = true;
			if (run.id !== null) cancelNativeRun(native, run.id);
			return;
		}
		const rec = recognition;
		if (!rec) return;
		recognition = null;
		listening.value = false;
		interim.value = '';
		rec.abort();
	}

	// Nobody dictates to a page they cannot see, and the mic must not keep
	// listening once its indicator is out of sight: a minimized window, a hidden
	// app, a background tab. The desktop shell ends its session for these too;
	// this covers any way out of sight it does not hear about. A field hidden
	// inside a page that is still shown is `DictationButton`'s to notice.
	function onVisibilityChange() {
		if (document.hidden) cancel();
	}
	if (typeof document !== 'undefined') {
		document.addEventListener('visibilitychange', onVisibilityChange);
	}

	onScopeDispose(() => {
		disposed = true;
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', onVisibilityChange);
		}
		cancel();
	});

	return {
		available: readonly(available),
		onDevice: readonly(onDevice),
		listening: readonly(listening),
		interim: readonly(interim),
		error,
		start,
		stop,
		cancel,
	};
}
