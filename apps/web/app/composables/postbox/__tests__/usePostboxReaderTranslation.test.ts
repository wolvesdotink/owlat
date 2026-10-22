/**
 * "Translate" in the reader: the text it sends (text part first, HTML reduced to
 * text, long mail clipped), the language it asks for, and what the panel shows
 * for a translation, a budget refusal, a stale answer and a change of message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { AI_BUDGET_ERROR_CODE } from '@owlat/shared/aiRouting';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { BUDGET_REASON_KEYS } from '~/utils/aiBudget';
import {
	MAX_TRANSLATION_CHARS,
	type TranslatableMessage,
	translationSource,
	usePostboxReaderTranslation,
} from '../usePostboxReaderTranslation';

const action = vi.fn();
// Only the body-loading race needs it: every other case carries its body inline.
const consumeBody = vi.hoisted(() => vi.fn());
vi.mock('../postboxBodyResolver', () => ({ consumeResolvedPostboxMessageBody: consumeBody }));

beforeEach(() => {
	action.mockReset();
	vi.stubGlobal('useI18n', i18nStubs.useI18n);
	vi.stubGlobal('requireConvex', () => ({ action }));
});

function setup(message: TranslatableMessage | undefined | (() => TranslatableMessage | undefined)) {
	let translation!: ReturnType<typeof usePostboxReaderTranslation>;
	const target = typeof message === 'function' ? message : () => message;
	mount(
		defineComponent({
			setup() {
				translation = usePostboxReaderTranslation(target);
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	return translation;
}

describe('translationSource', () => {
	it('prefers the text part, reduces HTML to text, and clips long mail', () => {
		expect(translationSource({ html: '<p>Hallo</p>', text: 'Hallo Welt' })).toEqual({
			text: 'Hallo Welt',
			truncated: false,
		});
		expect(translationSource({ html: '<p>Hallo <b>Welt</b></p>', text: '  ' }).text).toBe(
			'Hallo Welt'
		);
		const long = translationSource({ html: null, text: 'x'.repeat(MAX_TRANSLATION_CHARS + 5) });
		expect(long.text).toHaveLength(MAX_TRANSLATION_CHARS);
		expect(long.truncated).toBe(true);
	});
});

describe('usePostboxReaderTranslation', () => {
	it('translates the message as plain text into the app’s language', async () => {
		action.mockResolvedValue({ translations: [{ id: 'm1', translatedText: ' Hello world ' }] });
		const translation = setup({ _id: 'm1', textBodyInline: 'Hallo Welt' });
		expect(translation.targetLanguage.value).toBe('English');

		await translation.translate();
		expect(action).toHaveBeenCalledTimes(1);
		expect(action.mock.calls[0]![1]).toMatchObject({
			items: [{ id: 'm1', text: 'Hallo Welt', isHtml: false }],
			targetLanguage: 'English',
		});
		expect(translation.state.value).toEqual({
			status: 'done',
			text: 'Hello world',
			truncated: false,
		});

		translation.close();
		expect(translation.state.value).toEqual({ status: 'idle' });
	});

	it('says which budget refused it instead of a generic failure', async () => {
		action.mockRejectedValue({
			data: { data: { code: AI_BUDGET_ERROR_CODE, reason: 'daily_ceiling' } },
		});
		const translation = setup({ _id: 'm1', textBodyInline: 'Hallo' });
		await translation.translate();
		expect(translation.state.value).toEqual({
			status: 'error',
			messageKey: BUDGET_REASON_KEYS.daily_ceiling,
		});

		action.mockRejectedValue(new Error('network'));
		await translation.translate();
		expect(translation.state.value).toEqual({
			status: 'error',
			messageKey: 'postbox.reader.translation.failed',
		});
	});

	it('reports a message with nothing to translate without spending', async () => {
		const translation = setup({ _id: 'm1', textBodyInline: '   ', htmlBodyInline: '<p> </p>' });
		await translation.translate();
		expect(action).not.toHaveBeenCalled();
		expect(translation.state.value).toEqual({
			status: 'error',
			messageKey: 'postbox.reader.translation.empty',
		});
	});

	it('drops an answer that arrives after the panel was closed', async () => {
		let resolve!: (value: unknown) => void;
		action.mockReturnValue(new Promise((r) => (resolve = r)));
		const translation = setup({ _id: 'm1', textBodyInline: 'Hallo' });
		const pending = translation.translate();
		translation.close();
		resolve({ translations: [{ id: 'm1', translatedText: 'Hello' }] });
		await pending;
		expect(translation.state.value).toEqual({ status: 'idle' });
	});

	it('drops the panel when the reader moves to another message', async () => {
		action.mockResolvedValue({ translations: [{ id: 'm1', translatedText: 'Hello' }] });
		const current = ref<TranslatableMessage>({ _id: 'm1', textBodyInline: 'Hallo' });
		const translation = setup(() => current.value);
		await translation.translate();
		expect(translation.state.value.status).toBe('done');

		current.value = { _id: 'm2', textBodyInline: 'Bonjour' };
		await nextTick();
		expect(translation.state.value).toEqual({ status: 'idle' });
	});

	it('never lets an answer for the previous message fill the next one’s panel', async () => {
		let resolve!: (value: unknown) => void;
		action.mockReturnValue(new Promise((r) => (resolve = r)));
		const current = ref<TranslatableMessage>({ _id: 'm1', textBodyInline: 'Hallo' });
		const translation = setup(() => current.value);
		const pending = translation.translate();

		current.value = { _id: 'm2', textBodyInline: 'Bonjour' };
		await nextTick();
		resolve({ translations: [{ id: 'm1', translatedText: 'Hello' }] });
		await pending;
		expect(translation.state.value).toEqual({ status: 'idle' });
	});

	it('spends nothing when the message changes while its body is still loading', async () => {
		let resolveBody!: (value: unknown) => void;
		consumeBody.mockReturnValue(new Promise((r) => (resolveBody = r)));
		const current = ref<TranslatableMessage>({ _id: 'm1' });
		const translation = setup(() => current.value);
		const pending = translation.translate();

		current.value = { _id: 'm2', textBodyInline: 'Bonjour' };
		await nextTick();
		resolveBody({ html: null, text: 'Hallo' });
		await pending;
		expect(action).not.toHaveBeenCalled();
		expect(translation.state.value).toEqual({ status: 'idle' });
	});
});
