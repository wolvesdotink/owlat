// @vitest-environment happy-dom
/**
 * Answer mode's wiring around the composer (composables/useAnswerModeAssist):
 *   - the catch-up gets the view and message count (it decides the opening
 *     view and the footer note; useAnswerCatchUp.test.ts);
 *   - a reply the AI prepared earlier goes into an untouched fresh reply only,
 *     with the files answered for it;
 *   - a thread file is copied onto the draft by its index id, and uploaded from
 *     the message when the index does not hold it; a chip dropped on the
 *     composer attaches the same way;
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, shallowRef } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useAnswerModeAssist } from '../useAnswerModeAssist';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';
import type { AnswerConversationView } from '~/components/answer/AnswerConversation.vue';
import { THREAD_FILE_DRAG_TYPE, type ThreadFile } from '~/utils/answerThreadFiles';

vi.mock('@owlat/api', () => ({ api: { mail: { drafts: { attachExisting: 'attachExisting' } } } }));

const catchUpState = {
	catchUp: ref<{ asks: { id: string }[] } | null>(null),
	loading: ref(false),
	covered: ref<string[]>([]),
	statusNote: ref<string | undefined>(undefined),
	checkCoverage: vi.fn(async () => {}),
};
/** What the assist handed the catch-up (its view and message count). */
let catchUpOpts: { view?: unknown; messageCount?: () => number | undefined } = {};
vi.mock('~/composables/useAnswerCatchUp', () => ({
	useAnswerCatchUp: (opts: typeof catchUpOpts) => {
		catchUpOpts = opts;
		return catchUpState;
	},
}));
vi.mock('~/composables/useAnswerAskSession', () => ({ useAnswerAskSession: () => ({}) }));
const preparedText = ref<string | null>(null);
const preparedAttach = vi.fn(async () => {});
vi.mock('~/composables/useAnswerPreparedDraft', () => ({
	useAnswerPreparedDraft: () => ({ text: preparedText, attachFiles: preparedAttach }),
}));
const indexIdOf = vi.fn();
const toFile = vi.fn();
vi.mock('~/composables/useAnswerThreadFiles', () => ({
	useAnswerThreadFiles: () => ({ indexIdOf, toFile }),
}));
const upload = vi.fn();
vi.mock('~/composables/useAnswerFileUpload', () => ({
	useAnswerFileUpload: () => ({ upload }),
}));

const attachRun = vi.fn();
const showToast = vi.fn();

beforeEach(() => {
	catchUpState.catchUp.value = null;
	catchUpState.loading.value = false;
	catchUpState.covered.value = [];
	catchUpOpts = {};
	preparedText.value = null;
	indexIdOf.mockReset();
	toFile.mockReset();
	upload.mockReset();
	attachRun.mockReset();
	showToast.mockReset();
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useToast: () => ({ showToast }),
		useFeatureFlag: () => ({ isEnabled: () => true }),
		useBackendOperation: () => ({ run: attachRun, isLoading: ref(false) }),
	});
});

function composerMock(written = ''): AnswerComposerApi {
	return {
		draftText: ref(written),
		aiDraft: ref(null),
		ensureDraftId: vi.fn(async () => 'd1' as never),
		streamAiDraft: vi.fn(),
		applyAiDraft: vi.fn(async () => {}),
		discardAiDraft: vi.fn(),
		setAttachments: vi.fn(),
		addFiles: vi.fn(async () => {}),
		setFollowUp: vi.fn(),
		focusBody: vi.fn(),
	};
}

function host(opts: { composer?: AnswerComposerApi | null; count?: number; fresh?: boolean } = {}) {
	// Shallow, as the page holds it: the API's refs stay refs.
	const composer = shallowRef<AnswerComposerApi | null>(opts.composer ?? null);
	const count = ref<number | undefined>(opts.count);
	const view = ref<AnswerConversationView>('summary');
	let assist!: ReturnType<typeof useAnswerModeAssist>;
	mount(
		defineComponent({
			setup() {
				assist = useAnswerModeAssist({
					message: () => ({ _id: 'm1', mailboxId: 'mbx_1', threadId: 'thr_1' }),
					composer: () => composer.value,
					draftId: () => null,
					freshReply: () => opts.fresh ?? true,
					messageCount: () => count.value,
					view,
				});
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	return { assist, composer, count, view };
}

const FILE: ThreadFile = {
	key: 'm2:2',
	messageId: 'm2',
	filename: 'po.pdf',
	contentType: 'application/pdf',
	size: 9,
	partIndex: '2',
	receivedAt: 1,
};

describe('useAnswerModeAssist: the view', () => {
	it('hands the catch-up the conversation view and count it decides the opening view from', () => {
		const { view, count } = host({ count: 4 });
		expect(catchUpOpts.view).toBe(view);
		count.value = 2;
		expect(catchUpOpts.messageCount?.()).toBe(2);
	});
});

describe('useAnswerModeAssist: a prepared draft', () => {
	it('goes into an untouched fresh reply, once', async () => {
		const composer = composerMock();
		host({ composer });
		preparedText.value = 'Hi Jonas, here it is.';
		await flushPromises();
		expect(composer.applyAiDraft).toHaveBeenCalledWith('Hi Jonas, here it is.');
		// The files answered on the Reply Queue follow the text onto the draft.
		expect(preparedAttach).toHaveBeenCalledWith(composer);
		expect(catchUpState.checkCoverage).toHaveBeenCalled();
		preparedText.value = 'Another';
		await flushPromises();
		expect(composer.applyAiDraft).toHaveBeenCalledTimes(1);
	});

	it('never replaces something already written', async () => {
		const composer = composerMock('my own words');
		preparedText.value = 'AI words';
		host({ composer });
		await flushPromises();
		expect(composer.applyAiDraft).not.toHaveBeenCalled();
	});
});

describe('useAnswerModeAssist: the starter reply of the queue', () => {
	beforeEach(() => {
		preparedAttach.mockClear();
	});

	// Issue #1131: the arrival draft opened the page; the person then gave the
	// invoices, and the reply written from them must arrive with them.
	it('replaces the arrival draft and attaches the answered files', async () => {
		const composer = composerMock();
		const { assist } = host({ composer });
		preparedText.value = 'Here are your invoices [[invoices]]';
		await flushPromises();
		preparedAttach.mockClear();

		preparedText.value = 'Here are your invoices, attached.';
		await assist.applyQueueDraft(composer, 'Here are your invoices, attached.');
		expect(composer.applyAiDraft).toHaveBeenLastCalledWith('Here are your invoices, attached.');
		expect(preparedAttach).toHaveBeenCalledOnce();
	});

	it('attaches once when the prepared-draft watcher took the same reply first', async () => {
		const composer = composerMock();
		const { assist } = host({ composer });
		preparedText.value = 'Here they are.';
		await flushPromises();
		expect(preparedAttach).toHaveBeenCalledOnce();

		await assist.applyQueueDraft(composer, 'Here they are.');
		expect(composer.applyAiDraft).toHaveBeenCalledOnce();
		expect(preparedAttach).toHaveBeenCalledOnce();
	});

	it('keeps the watcher from applying a reply the queue already put in', async () => {
		const composer = composerMock();
		const { assist } = host({ composer });
		await assist.applyQueueDraft(composer, 'Here they are.');
		preparedText.value = 'Here they are.';
		await flushPromises();
		expect(composer.applyAiDraft).toHaveBeenCalledOnce();
		expect(preparedAttach).toHaveBeenCalledOnce();
	});
});

describe('useAnswerModeAssist: thread files', () => {
	it('copies an indexed file onto the draft', async () => {
		const composer = composerMock();
		const { assist } = host({ composer });
		indexIdOf.mockResolvedValue('ma_1');
		attachRun.mockResolvedValue({ ok: true, result: [{ storageId: 'st_1', filename: 'po.pdf' }] });
		await assist.attachThreadFile(FILE);
		expect(attachRun).toHaveBeenCalledWith({ draftId: 'd1', source: 'mailAttachment', id: 'ma_1' });
		expect(composer.setAttachments).toHaveBeenCalledWith([
			{ storageId: 'st_1', filename: 'po.pdf' },
		]);
		expect(assist.attaching.value).toBeNull();
	});

	it('uploads it from the message when the index does not hold it', async () => {
		const composer = composerMock();
		const { assist } = host({ composer });
		indexIdOf.mockResolvedValue(null);
		const local = new File(['x'], 'po.pdf');
		toFile.mockResolvedValue(local);
		await assist.attachThreadFile(FILE);
		expect(attachRun).not.toHaveBeenCalled();
		expect(composer.addFiles).toHaveBeenCalledWith([local]);
	});

	it('attaches a chip dropped on the composer, and ignores other drops', async () => {
		const composer = composerMock();
		const { assist } = host({ composer });
		indexIdOf.mockResolvedValue(null);
		toFile.mockResolvedValue(null);
		const drop = (data: Record<string, string>) =>
			({ dataTransfer: { getData: (t: string) => data[t] ?? '' } }) as unknown as DragEvent;
		assist.onComposerDrop(drop({ 'text/plain': 'x' }));
		expect(indexIdOf).not.toHaveBeenCalled();
		assist.onComposerDrop(drop({ [THREAD_FILE_DRAG_TYPE]: JSON.stringify(FILE) }));
		await flushPromises();
		expect(indexIdOf).toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith('The file could not be attached.', 'error');
	});

	it('answers a file question with a thread file: by index id, else as an upload', async () => {
		const { assist } = host({ composer: composerMock() });
		indexIdOf.mockResolvedValueOnce('ma_1');
		expect(await assist.resolveThreadFile(FILE)).toEqual({
			source: 'mailAttachment',
			id: 'ma_1',
			filename: 'po.pdf',
		});
		indexIdOf.mockResolvedValueOnce(null);
		toFile.mockResolvedValueOnce(new File(['x'], 'po.pdf'));
		upload.mockResolvedValueOnce({ storageId: 'st_9', filename: 'po.pdf' });
		expect(await assist.resolveThreadFile(FILE)).toEqual({
			source: 'upload',
			id: 'st_9',
			filename: 'po.pdf',
		});
	});
});

describe('useAnswerModeAssist: the footer note', () => {
	it("is the catch-up's own note", () => {
		const { assist } = host();
		expect(assist.statusNote).toBe(catchUpState.statusNote);
	});
});
