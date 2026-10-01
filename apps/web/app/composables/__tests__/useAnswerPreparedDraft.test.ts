/**
 * The reply the AI prepared for a thread, read per thread: the clarification
 * draft wins over the draft-on-arrival slot, and nothing is read for a resumed
 * draft (the whole mailbox's queue is never subscribed to for it). The files
 * given as answers on the Reply Queue go onto the reply's draft; one that
 * cannot be attached gets a quiet note and never holds the draft up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { useAnswerPreparedDraft } from '../useAnswerPreparedDraft';
import type { AnswerComposerApi } from '~/composables/postbox/usePostboxComposerAnswerApi';

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			needsReplyPrepared: { getPreparedDraft: 'getPreparedDraft' },
			drafts: {
				attachExisting: 'attachExisting',
				addAttachment: 'addAttachment',
				get: 'drafts.get',
			},
		},
	},
}));

let data: Ref<unknown>;
const calls: Array<{ fn: unknown; args: unknown }> = [];
const runs: Record<string, ReturnType<typeof vi.fn>> = {};
const showToast = vi.fn();
const query = vi.fn();

beforeEach(() => {
	data = ref(undefined);
	calls.length = 0;
	showToast.mockReset();
	query.mockReset();
	query.mockResolvedValue({
		attachments: [
			{ storageId: 'st_c', filename: 'po.pdf', contentType: 'application/pdf', size: 9 },
		],
	});
	runs['attachExisting'] = vi.fn(async () => ({ ok: true, result: [] }));
	runs['addAttachment'] = vi.fn(async () => ({ ok: true, result: { ok: true } }));
	vi.stubGlobal('useConvexQuery', (fn: unknown, args: () => unknown) => {
		calls.push({ fn, args: args() });
		return { data };
	});
	vi.stubGlobal('useI18n', () => ({
		t: (key: string, params?: Record<string, unknown>) => `${key}:${params?.['filename'] ?? ''}`,
	}));
	vi.stubGlobal('useToast', () => ({ showToast }));
	vi.stubGlobal('useBackendOperation', (fn: string) => ({ run: runs[fn], isLoading: ref(false) }));
	vi.stubGlobal('requireConvex', () => ({ query }));
});

function composerMock(draftId: string | null = 'd1'): AnswerComposerApi {
	return {
		draftText: ref(''),
		aiDraft: ref(null),
		ensureDraftId: vi.fn(async () => draftId as never),
		streamAiDraft: vi.fn(),
		applyAiDraft: vi.fn(async () => {}),
		discardAiDraft: vi.fn(),
		setAttachments: vi.fn(),
		addFiles: vi.fn(async () => {}),
		setFollowUp: vi.fn(),
		focusBody: vi.fn(),
	};
}

describe('useAnswerPreparedDraft', () => {
	it('reads the one thread and prefers the clarification draft', () => {
		const { text } = useAnswerPreparedDraft({ threadId: () => 'thr_1', enabled: () => true });
		expect(calls).toEqual([{ fn: 'getPreparedDraft', args: { threadId: 'thr_1' } }]);
		data.value = { clarificationDraft: 'With your answers', slotDraft: 'On arrival' };
		expect(text.value).toBe('With your answers');
		data.value = { clarificationDraft: null, slotDraft: 'On arrival' };
		expect(text.value).toBe('On arrival');
	});

	it('reads nothing when not a fresh reply', () => {
		const { text } = useAnswerPreparedDraft({ threadId: () => 'thr_1', enabled: () => false });
		expect(calls[0]?.args).toBe('skip');
		expect(text.value).toBeNull();
	});

	it('attaches the answered files: Files and mail attachments copied, an upload bound', async () => {
		const prepared = useAnswerPreparedDraft({ threadId: () => 'thr_1', enabled: () => true });
		data.value = {
			clarificationDraft: 'Attached.',
			slotDraft: null,
			files: [
				{ source: 'semanticFile', id: 'sf_1', filename: 'po.pdf' },
				{ source: 'mailAttachment', id: 'ma_1', filename: 'august.pdf' },
				{ source: 'upload', id: 'st_1', filename: 'scan.jpg' },
			],
		};
		const composer = composerMock();
		await prepared.attachFiles(composer);

		expect(runs['attachExisting']!.mock.calls.map((c) => c[0])).toEqual([
			{ draftId: 'd1', source: 'semanticFile', id: 'sf_1' },
			{ draftId: 'd1', source: 'mailAttachment', id: 'ma_1' },
		]);
		expect(runs['addAttachment']).toHaveBeenCalledWith({
			draftId: 'd1',
			storageId: 'st_1',
			filename: 'scan.jpg',
			contentType: 'image/jpeg',
			size: 0,
		});
		// The chips show what the draft now holds.
		expect(composer.setAttachments).toHaveBeenCalledWith([
			{ storageId: 'st_c', filename: 'po.pdf', contentType: 'application/pdf', size: 9 },
		]);
		expect(showToast).not.toHaveBeenCalled();
	});

	it('says quietly which file could not be attached, and attaches the rest', async () => {
		runs['attachExisting']!.mockResolvedValueOnce({ ok: false });
		const prepared = useAnswerPreparedDraft({ threadId: () => 'thr_1', enabled: () => true });
		data.value = {
			clarificationDraft: 'Attached.',
			slotDraft: null,
			files: [
				{ source: 'semanticFile', id: 'sf_gone', filename: 'gone.pdf' },
				{ source: 'upload', id: 'st_1', filename: 'scan.pdf' },
			],
		};
		await prepared.attachFiles(composerMock());

		expect(runs['addAttachment']).toHaveBeenCalledOnce();
		expect(showToast).toHaveBeenCalledWith(
			'components.answer.aiBar.preparedFileFailed:gone.pdf',
			'info'
		);
	});

	it('does nothing for a prepared reply without files (or a deployment that sends none)', async () => {
		const prepared = useAnswerPreparedDraft({ threadId: () => 'thr_1', enabled: () => true });
		data.value = { clarificationDraft: 'Hi', slotDraft: null };
		const composer = composerMock();
		await prepared.attachFiles(composer);
		expect(composer.ensureDraftId).not.toHaveBeenCalled();
	});
});
