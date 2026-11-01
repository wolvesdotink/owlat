import { api } from '@owlat/api';
import { htmlToPlainText } from '@owlat/shared/html';
import { budgetCopyKeyOfError } from '~/utils/aiBudget';
import { consumeResolvedPostboxMessageBody } from './postboxBodyResolver';

/** The parts of a message a translation reads. */
export interface TranslatableMessage {
	_id: string;
	htmlBodyInline?: string;
	textBodyInline?: string;
}

/** How much text one translation sends; a newsletter's tail is not worth the spend. */
export const MAX_TRANSLATION_CHARS = 20_000;

export type ReaderTranslationState =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'done'; text: string; truncated: boolean }
	| { status: 'error'; messageKey: string };

/**
 * The plain text a translation starts from: the text part when there is one,
 * else the HTML part reduced to text, clipped to {@link MAX_TRANSLATION_CHARS}.
 * Text, not HTML, on purpose: the result is rendered as text, so nothing the
 * model returns can ever become markup in the reader. Pure.
 */
export function translationSource(body: { html: string | null; text: string | null }): {
	text: string;
	truncated: boolean;
} {
	const plain = (body.text?.trim() ? body.text : htmlToPlainText(body.html ?? '')).trim();
	return {
		text: plain.slice(0, MAX_TRANSLATION_CHARS),
		truncated: plain.length > MAX_TRANSLATION_CHARS,
	};
}

/**
 * "Translate" in the reader: one message (the reader picks the newest one
 * somebody else wrote), in the language the app is shown in, as a panel above
 * the conversation. The source message is never
 * touched: the translation is a separate, dismissible reading of it.
 *
 * It spends through `emailTemplates/translate.translateBatch`, which checks the `ai` flag, the
 * organization's AI budget and a per-user rate limit before any model runs; a
 * budget refusal reads as which budget, not as a failed translation.
 */
export function usePostboxReaderTranslation(message: () => TranslatableMessage | undefined) {
	const { locale } = useI18n();
	const state = ref<ReaderTranslationState>({ status: 'idle' });
	let request = 0;

	/** The UI language's name, in `inLocale` ("German" in English, "Deutsch" in German). */
	function languageName(inLocale: string): string {
		try {
			return (
				new Intl.DisplayNames([inLocale], { type: 'language' }).of(locale.value) ?? locale.value
			);
		} catch {
			return locale.value;
		}
	}
	/** What the panel heading names: the language in its own words. */
	const targetLanguage = computed(() => languageName(locale.value));

	// A translation belongs to one message in one language. The reader keeps this
	// composable across previews, so a new target (another conversation, a newer
	// message, a language switch) drops the panel and any answer still in flight.
	watch([() => message()?._id, locale], () => close());

	async function bodyOf(msg: TranslatableMessage) {
		if (msg.textBodyInline?.trim() || msg.htmlBodyInline?.trim()) {
			return { html: msg.htmlBodyInline ?? null, text: msg.textBodyInline ?? null };
		}
		return consumeResolvedPostboxMessageBody(requireConvex(), msg._id);
	}

	async function translate() {
		const msg = message();
		if (!msg) return;
		const current = ++request;
		state.value = { status: 'loading' };
		try {
			const body = await bodyOf(msg);
			// Superseded while the body loaded: spend nothing on a stale target.
			if (current !== request) return;
			const source = translationSource(body ?? { html: null, text: null });
			if (!source.text) {
				state.value = { status: 'error', messageKey: 'postbox.reader.translation.empty' };
				return;
			}
			const result = await requireConvex().action(api.emailTemplates.translate.translateBatch, {
				items: [{ id: msg._id, text: source.text, isHtml: false }],
				sourceLanguage: 'the language it is written in',
				// The prompt is English, so it names the language in English.
				targetLanguage: languageName('en'),
			});
			if (current !== request) return;
			const text = result.translations.find((item) => item.id === msg._id)?.translatedText;
			state.value = text?.trim()
				? { status: 'done', text: text.trim(), truncated: source.truncated }
				: { status: 'error', messageKey: 'postbox.reader.translation.failed' };
		} catch (error) {
			if (current !== request) return;
			state.value = {
				status: 'error',
				messageKey: budgetCopyKeyOfError(error) ?? 'postbox.reader.translation.failed',
			};
		}
	}

	function close() {
		request += 1;
		state.value = { status: 'idle' };
	}

	return { state, targetLanguage, translate, close };
}
