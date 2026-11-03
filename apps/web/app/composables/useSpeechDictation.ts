/**
 * Speech to text through the Web Speech API, one finished phrase at a time.
 *
 * Owlat never receives or stores audio: the engine belongs to the browser (or
 * the desktop app's webview) and only its text reaches the page. Where the
 * engine can run on this device for the language (Chromium's `processLocally`)
 * it is asked to, and `onDevice` says so. Otherwise the browser's own speech
 * service hears the audio, which for most browsers means a cloud service, and
 * the UI has to say that.
 *
 * The desktop app offers dictation only on-device. Its macOS webview has no
 * on-device mode and the app declares no microphone or speech-recognition
 * usage, which macOS requires before it lets an app listen.
 *
 * Hidden, not broken: `available` stays false until a mounted check finds an
 * engine (never during SSR, so server and client markup agree).
 */
import { onMounted, onScopeDispose, readonly, ref } from 'vue';
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
	let disposed = false;

	// The language people speak most often matches their browser's, not the
	// UI's (Owlat has two). A transcript goes in as spoken, never translated.
	const lang = () => (typeof navigator !== 'undefined' && navigator.language) || 'en-US';

	onMounted(async () => {
		const Ctor = recognitionConstructor();
		if (!Ctor) return;
		const local = await canRunOnDevice(Ctor, lang());
		if (disposed) return;
		onDevice.value = local;
		available.value = local || !isDesktop.value;
	});

	function start() {
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
		recognition?.stop();
	}

	/** Stop listening and drop the phrase being heard. Phrases already in stay. */
	function cancel() {
		const rec = recognition;
		if (!rec) return;
		recognition = null;
		listening.value = false;
		interim.value = '';
		rec.abort();
	}

	onScopeDispose(() => {
		disposed = true;
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
