// @vitest-environment happy-dom
/**
 * "Draft with AI" from the composer's side (composables/useAnswerAskSession):
 *   - `start` makes sure the draft row exists and sends the instruction;
 *   - `answer` sends the answers (or a skip) for the live session;
 *   - a stream seen running goes into the editor as it arrives and is settled
 *     once when complete: the AI text, the promised follow-up date, and the
 *     attachments the server added;
 *   - a finished stream found on a reload is left alone (the saved body
 *     already has it, maybe edited since).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';

import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useAnswerAskSession } from '../useAnswerAskSession';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			ai: {
				composeDraftStore: { getSession: 'getSession' },
				composeDraft: { start: 'start', answer: 'answer' },
			},
			draftStreamStore: { getDraftStream: 'getDraftStream' },
			drafts: { get: 'drafts.get' },
		},
	},
}));

const data: Record<string, Ref<unknown>> = {};
const runs: Record<string, ReturnType<typeof vi.fn>> = {};
const query = vi.fn();
/** The `onError` each operation was given, by function. */
const onErrors: Record<string, ((op: unknown) => boolean) | undefined> = {};
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function session(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: 's1',
		target: { kind: 'mailDraft', draftId: 'd1' },
		status: 'drafting',
		round: 1,
		questions: [],
		attachedFiles: [],
		locale: 'en',
		updatedAt: 1,
		...overrides,
	};
}

beforeEach(() => {
	data['getSession'] = ref(undefined);
	data['getDraftStream'] = ref(undefined);
	runs['start'] = vi.fn(async () => ({ ok: true, result: session({ status: 'asking' }) }));
	runs['answer'] = vi.fn(async () => ({ ok: true, result: session({ updatedAt: 2 }) }));
	query.mockReset();
	query.mockResolvedValue({
		attachments: [
			{ storageId: 'st_1', filename: 'po.pdf', contentType: 'application/pdf', size: 9 },
		],
	});
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useConvexQuery: (fn: string) => ({ data: data[fn] }),
		useBackendOperation: (fn: string, opts?: { onError?: (op: unknown) => boolean }) => {
			onErrors[fn] = opts?.onError;
			return { run: runs[fn], isLoading: ref(false) };
		},
		requireConvex: () => ({ query }),
	});
});

function composerMock(): AnswerComposerApi {
	return {
		draftText: ref(''),
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

function host(composer: AnswerComposerApi, draftId = ref<string | null>('d1')) {
	const onSettled = vi.fn();
	let api!: ReturnType<typeof useAnswerAskSession>;
	mount(
		defineComponent({
			setup() {
				api = useAnswerAskSession({
					target: () =>
						draftId.value ? { kind: 'mailDraft', draftId: draftId.value as never } : null,
					composer: () => composer,
					onSettled,
				});
				return () => h('div');
			},
		}),
		{ global: { plugins: [createTestI18n()] } }
	);
	return { api, onSettled };
}

describe('useAnswerAskSession', () => {
	it('starts on the draft row with the instruction and the locale', async () => {
		const composer = composerMock();
		const { api } = host(composer, ref(null));
		await api.start('  say sorry it is late ');
		expect(composer.ensureDraftId).toHaveBeenCalled();
		expect(runs['start']).toHaveBeenCalledWith({
			target: { kind: 'mailDraft', draftId: 'd1' },
			instruction: 'say sorry it is late',
			locale: 'en',
			// Promised dates land at 09:00 on the owner's calendar.
			timeZone: ZONE,
		});
		// The returned view shows before the subscription catches up.
		expect(api.phase.value).toBe('asking');
	});

	it('answers the live session, or skips', async () => {
		data['getSession']!.value = session({ status: 'asking' });
		const { api } = host(composerMock());
		await api.answer([{ questionId: 'q1', value: 'Yes' }], true);
		expect(runs['answer']).toHaveBeenCalledWith({
			sessionId: 's1',
			answers: [{ questionId: 'q1', value: 'Yes' }],
			skip: true,
			timeZone: ZONE,
		});
	});

	it('takes a double submit quietly: the first answer is already drafting', () => {
		host(composerMock());
		const claim = onErrors['answer']!;
		expect(
			claim({ category: 'invalid_state', message: 'These questions were already answered' })
		).toBe(true);
		// Anything else still surfaces.
		expect(claim({ category: 'forbidden', message: 'No' })).toBe(false);
		expect(
			claim({ category: 'invalid_state', message: 'Gaps', data: { code: 'DRAFT_HAS_GAPS' } })
		).toBe(false);
		expect(
			claim({ category: 'invalid_state', message: 'Attachments can only be sent on email threads' })
		).toBe(false);
	});

	it('streams into the editor, then settles the draft, the follow-up and the files once', async () => {
		const composer = composerMock();
		const { api, onSettled } = host(composer);
		data['getSession']!.value = session({ streamId: 'ds1', followUpAt: 1790000000000 });
		data['getDraftStream']!.value = {
			_id: 'ds1',
			status: 'streaming',
			text: 'Hi Jo',
			injectionFlagged: false,
		};
		await nextTick();
		expect(api.phase.value).toBe('drafting');
		expect(composer.streamAiDraft).toHaveBeenLastCalledWith('Hi Jo');

		data['getDraftStream']!.value = {
			_id: 'ds1',
			status: 'complete',
			text: 'Hi Jonas, attached. [[the PO number]]',
			injectionFlagged: true,
		};
		await flushPromises();
		expect(api.phase.value).toBe('ready');
		expect(composer.applyAiDraft).toHaveBeenCalledTimes(1);
		expect(composer.applyAiDraft).toHaveBeenCalledWith('Hi Jonas, attached. [[the PO number]]');
		expect(composer.setFollowUp).toHaveBeenCalledWith(1790000000000);
		expect(query).toHaveBeenCalledWith('drafts.get', { draftId: 'd1' });
		expect(composer.setAttachments).toHaveBeenCalledWith([
			{ storageId: 'st_1', filename: 'po.pdf', contentType: 'application/pdf', size: 9 },
		]);
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(api.injectionFlagged.value).toBe(true);

		// A later update of the same stream does not apply it again.
		data['getDraftStream']!.value = {
			_id: 'ds1',
			status: 'complete',
			text: 'x',
			injectionFlagged: false,
		};
		await flushPromises();
		expect(composer.applyAiDraft).toHaveBeenCalledTimes(1);
	});

	it('leaves a stream that finished before this page opened alone', async () => {
		const composer = composerMock();
		data['getSession']!.value = session({ status: 'ready', streamId: 'ds1' });
		data['getDraftStream']!.value = {
			_id: 'ds1',
			status: 'complete',
			text: 'old',
			injectionFlagged: false,
		};
		host(composer);
		await flushPromises();
		expect(composer.applyAiDraft).not.toHaveBeenCalled();
		expect(composer.streamAiDraft).not.toHaveBeenCalled();
	});

	it('drafts a team thread on the thread itself, and hands back the files it found once', async () => {
		const composer = composerMock();
		const onAttachedFiles = vi.fn();
		const file = { source: 'semanticFile' as const, id: 'sf_1', filename: 'invoice.pdf' };
		runs['start'] = vi.fn(async () => ({
			ok: true,
			result: session({ target: { kind: 'teamThread', threadId: 'ct_1' }, attachedFiles: [file] }),
		}));
		let api!: ReturnType<typeof useAnswerAskSession>;
		mount(
			defineComponent({
				setup() {
					api = useAnswerAskSession({
						target: () => ({ kind: 'teamThread', threadId: 'ct_1' as never }),
						composer: () => composer,
						onAttachedFiles,
					});
					return () => h('div');
				},
			}),
			{ global: { plugins: [createTestI18n()] } }
		);
		await api.start('');
		await nextTick();
		expect(composer.ensureDraftId).not.toHaveBeenCalled();
		expect(runs['start']).toHaveBeenCalledWith({
			target: { kind: 'teamThread', threadId: 'ct_1' },
			locale: 'en',
			timeZone: ZONE,
		});
		expect(onAttachedFiles).toHaveBeenCalledWith([file]);
		// The subscription catching up reports nothing twice.
		data['getSession']!.value = session({
			target: { kind: 'teamThread', threadId: 'ct_1' },
			attachedFiles: [file],
			updatedAt: 5,
		});
		await nextTick();
		expect(onAttachedFiles).toHaveBeenCalledTimes(1);
	});

	it('does not hand back files a session found before this page opened', async () => {
		data['getSession']!.value = session({
			target: { kind: 'teamThread', threadId: 'ct_1' },
			attachedFiles: [{ source: 'semanticFile', id: 'sf_1', filename: 'old.pdf' }],
		});
		const onAttachedFiles = vi.fn();
		mount(
			defineComponent({
				setup() {
					useAnswerAskSession({
						target: () => ({ kind: 'teamThread', threadId: 'ct_1' as never }),
						composer: () => composerMock(),
						onAttachedFiles,
					});
					return () => h('div');
				},
			}),
			{ global: { plugins: [createTestI18n()] } }
		);
		await nextTick();
		expect(onAttachedFiles).not.toHaveBeenCalled();
	});
});
