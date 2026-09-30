// @vitest-environment happy-dom
/**
 * The composer's Answer mode API (composables/postbox/usePostboxComposerAnswerApi):
 *   - an AI draft replaces only what was written (quote and signature stay),
 *     and is recorded once as the draft's AI baseline after the row is saved;
 *   - Discard puts back what was written before the AI draft;
 *   - the footer says how many gaps are left, else the host's note, else the
 *     save state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { mount } from '@vue/test-utils';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { usePostboxComposerAnswerApi } from '../usePostboxComposerAnswerApi';

vi.mock('@owlat/api', () => ({ api: { mail: { drafts: { update: 'drafts.update' } } } }));

const QUOTE = '<br><br><div class="gmail_quote"><blockquote>Could you send it?</blockquote></div>';
const run = vi.fn(async () => ({ ok: true }));

beforeEach(() => {
	run.mockClear();
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useBackendOperation: () => ({ run, isLoading: ref(false) }),
	});
});

function setup(body = `<p>my notes</p>${QUOTE}`) {
	const state = {
		bodyHtml: ref(body),
		attachments: ref<{ storageId: string; filename: string; contentType: string; size: number }[]>(
			[]
		),
		followUpRemindAt: ref<number | null>(null),
		addFiles: vi.fn(async () => {}),
		flush: vi.fn(async () => ({ ok: true as const, result: 'd1' as never })),
		focusBody: vi.fn(),
		isSaving: ref(false),
		lastSavedAt: ref<number | null>(null),
		gapCount: ref(0),
		note: ref<string | undefined>(undefined),
		askSession: ref(false),
	};
	let result!: ReturnType<typeof usePostboxComposerAnswerApi>;
	mount(
		defineComponent({
			setup() {
				result = usePostboxComposerAnswerApi({
					...state,
					askSession: () => state.askSession.value,
					statusNote: () => state.note.value,
				});
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	return { state, ...result };
}

describe('usePostboxComposerAnswerApi', () => {
	it('reads what was written without the quote', () => {
		const { answerApi } = setup();
		expect(answerApi.draftText.value).toBe('my notes');
	});

	it('settles an AI draft above the quote and records it as the baseline', async () => {
		const { answerApi, state } = setup();
		answerApi.streamAiDraft('Hi Jo');
		expect(state.bodyHtml.value).toBe(`<p>Hi Jo</p>${QUOTE}`);
		await answerApi.applyAiDraft('Hi Jonas,\n\nattached.');
		expect(state.bodyHtml.value).toBe(`<p>Hi Jonas,</p><p>attached.</p>${QUOTE}`);
		expect(answerApi.aiDraft.value).toBe('Hi Jonas,\n\nattached.');
		expect(state.flush).toHaveBeenCalled();
		expect(run).toHaveBeenCalledWith({ draftId: 'd1', aiBaseline: 'Hi Jonas,\n\nattached.' });
	});

	it('puts back what was written before the AI draft on Discard', async () => {
		const { answerApi, state } = setup();
		await answerApi.applyAiDraft('AI text');
		answerApi.discardAiDraft();
		expect(state.bodyHtml.value).toBe(`<p>my notes</p>${QUOTE}`);
		expect(answerApi.aiDraft.value).toBeNull();
		expect(state.focusBody).toHaveBeenCalled();
	});

	it('takes the server attachments and the follow-up date', () => {
		const { answerApi, state } = setup();
		answerApi.setAttachments([
			{ storageId: 'st_1', filename: 'po.pdf', contentType: 'application/pdf', size: 9 },
		]);
		answerApi.setFollowUp(1790000000000);
		expect(state.attachments.value).toEqual([
			{ storageId: 'st_1', filename: 'po.pdf', contentType: 'application/pdf', size: 9 },
		]);
		expect(state.followUpRemindAt.value).toBe(1790000000000);
	});

	it('puts gaps first in the footer, then the host note, then the save state', () => {
		const { footerStatus, state, gapsHoldSend } = setup();
		state.lastSavedAt.value = Date.UTC(2026, 8, 30, 9, 31);
		expect(footerStatus.value).toMatch(/^Saved/);
		state.note.value = '2 of 3 asks covered';
		expect(footerStatus.value).toBe('2 of 3 asks covered');
		state.askSession.value = true;
		state.gapCount.value = 1;
		expect(gapsHoldSend.value).toBe(true);
		expect(footerStatus.value).toBe('1 gap left');
		state.gapCount.value = 3;
		expect(footerStatus.value).toBe('3 gaps left');
	});

	it('holds Send on gaps only when the AI wrote into this draft', async () => {
		const { answerApi, gapsHoldSend, footerStatus, state } = setup();
		state.note.value = '2 of 3 asks covered';
		state.gapCount.value = 1;
		// Brackets the person typed (a wiki link): advice, not a block.
		expect(gapsHoldSend.value).toBe(false);
		expect(footerStatus.value).toBe('2 of 3 asks covered');

		await answerApi.applyAiDraft('Attached. [[the PO number]]');
		expect(gapsHoldSend.value).toBe(true);

		answerApi.discardAiDraft();
		expect(gapsHoldSend.value).toBe(false);
	});
});
