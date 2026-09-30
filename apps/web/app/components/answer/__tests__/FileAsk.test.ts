// @vitest-environment happy-dom
/**
 * The answer to a file question (plan §06):
 *   - "choose a file" opens the OS picker and uploads; the answer names the
 *     upload and keeps a copy unless "Don't keep a copy" is ticked;
 *   - a type the upload policy refuses is refused here, before uploading;
 *   - a near-miss candidate reads "Close, but maybe not it" with its note;
 *   - "It isn't ready yet" is an answer of its own;
 *   - a thread file dropped on it becomes the answer; so does a Files pick.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import FileAsk from '../FileAsk.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { THREAD_FILE_DRAG_TYPE } from '~/utils/answerThreadFiles';

const upload = vi.fn();
vi.mock('~/composables/useAnswerFileUpload', () => ({
	useAnswerFileUpload: () => ({ upload, uploading: ref(false), progress: ref(0) }),
}));
const pickAnswerFile = vi.fn();
vi.mock('~/utils/answerFilePicker', async (importOriginal) => ({
	...(await importOriginal<typeof import('~/utils/answerFilePicker')>()),
	pickAnswerFile: () => pickAnswerFile(),
}));

const showToast = vi.fn();
beforeAll(() => {
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useToast: () => ({ showToast }),
	});
});
beforeEach(() => {
	upload.mockReset();
	pickAnswerFile.mockReset();
	showToast.mockReset();
});

const QUESTION = {
	id: 'file_request',
	slotType: 'attachment',
	answerKind: 'file' as const,
	text: 'They asked for "invoice for september". I couldn\'t find it in Files or earlier mail.',
	attribution: 'Generated from an email from example.org',
	options: ["It isn't ready yet"],
	fileCandidates: [
		{
			source: 'semanticFile' as const,
			id: 'sf_1',
			filename: 'invoice-2026-08-brightpath.pdf',
			mimeType: 'application/pdf',
			size: 84000,
			score: 0.6,
			note: 'August',
		},
	],
};

const PickerStub = defineComponent({
	name: 'AnswerFilePicker',
	props: ['open', 'mailboxId'],
	emits: ['update:open', 'pick'],
	setup: (props) => () => h('div', { 'data-testid': 'picker', 'data-open': String(props.open) }),
});

function mountAsk(props: Record<string, unknown> = {}) {
	return mount(FileAsk, {
		props: { question: QUESTION, options: QUESTION.options, modelValue: null, ...props },
		global: { plugins: [createTestI18n()], stubs: { AnswerFilePicker: PickerStub } },
	});
}
const lastValue = (w: ReturnType<typeof mountAsk>) => w.emitted('update:modelValue')?.at(-1)?.[0];

describe('FileAsk', () => {
	it('uploads a chosen file and answers with it, keeping a copy by default', async () => {
		pickAnswerFile.mockResolvedValue(
			new File(['%PDF'], 'invoice-2026-09.pdf', { type: 'application/pdf' })
		);
		upload.mockResolvedValue({
			storageId: 'st_1',
			filename: 'invoice-2026-09.pdf',
			contentType: 'application/pdf',
			size: 4,
		});
		const w = mountAsk();
		expect(w.text()).toContain("Attached to this reply and saved to the contact's Files");
		await w.get('[data-testid="file-ask-choose"]').trigger('click');
		await flushPromises();
		expect(lastValue(w)).toEqual({
			kind: 'file',
			file: { source: 'upload', id: 'st_1', filename: 'invoice-2026-09.pdf' },
			keepCopy: true,
		});
		expectFullyLocalized(w);
	});

	it('keeps no copy once "Don\'t keep a copy" is ticked', async () => {
		const picked = {
			kind: 'file',
			file: { source: 'upload', id: 'st_1', filename: 'a.pdf' },
			keepCopy: true,
		};
		const w = mountAsk({ modelValue: picked });
		await w.get('[data-testid="file-ask-dont-keep"]').setValue(true);
		expect(lastValue(w)).toEqual({ ...picked, keepCopy: false });
	});

	it('refuses a file type the upload policy would refuse, before uploading', async () => {
		const w = mountAsk();
		const file = new File(['x'], 'photo.heic', { type: 'image/heic' });
		await w.get('[data-testid="file-ask-drop"]').trigger('drop', {
			dataTransfer: { files: [file], getData: () => '' },
		});
		await flushPromises();
		expect(upload).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith(
			'photo.heic is not a file type that can be attached here.',
			'error'
		);
	});

	it('offers the near miss with its note, and answers with it on a click', async () => {
		const w = mountAsk();
		expect(w.text()).toContain('Close, but maybe not it:');
		const chip = w.get('[data-testid="file-ask-candidate"]');
		expect(chip.text()).toContain('invoice-2026-08-brightpath.pdf');
		expect(chip.text()).toContain('August');
		await chip.trigger('click');
		expect(lastValue(w)).toEqual({
			kind: 'file',
			file: { source: 'semanticFile', id: 'sf_1', filename: 'invoice-2026-08-brightpath.pdf' },
			keepCopy: true,
		});
	});

	it('takes "It isn\'t ready yet" as the answer, and a second tap clears it', async () => {
		const w = mountAsk();
		await w.get('[data-testid="file-ask-option"]').trigger('click');
		expect(lastValue(w)).toEqual({ kind: 'option', value: "It isn't ready yet" });
		await w.setProps({ modelValue: { kind: 'option', value: "It isn't ready yet" } });
		await w.get('[data-testid="file-ask-option"]').trigger('click');
		expect(lastValue(w)).toBeNull();
	});

	it('answers with a thread file dropped on it', async () => {
		const resolveThreadFile = vi.fn(async () => ({
			source: 'mailAttachment' as const,
			id: 'ma_1',
			filename: 'po.pdf',
		}));
		const w = mountAsk({ resolveThreadFile });
		const payload = JSON.stringify({ messageId: 'm1', filename: 'po.pdf', partIndex: '2' });
		await w.get('[data-testid="file-ask-drop"]').trigger('drop', {
			dataTransfer: {
				files: [],
				getData: (t: string) => (t === THREAD_FILE_DRAG_TYPE ? payload : ''),
			},
		});
		await flushPromises();
		expect(resolveThreadFile).toHaveBeenCalledWith(
			expect.objectContaining({ messageId: 'm1', partIndex: '2' })
		);
		expect(lastValue(w)).toMatchObject({ kind: 'file', file: { id: 'ma_1' } });
	});

	it('answers with a file picked from Files', async () => {
		const w = mountAsk();
		await w.get('[data-testid="file-ask-pick-files"]').trigger('click');
		expect(w.get('[data-testid="picker"]').attributes('data-open')).toBe('true');
		w.getComponent(PickerStub).vm.$emit('pick', {
			source: 'semanticFile',
			id: 'sf_9',
			filename: 'invoice-2026-09.pdf',
		});
		expect(lastValue(w)).toMatchObject({ kind: 'file', file: { id: 'sf_9' } });
	});
});
