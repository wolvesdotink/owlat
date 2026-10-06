import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { withSetup } from '~/__tests__/withSetup';
import { createTestI18n } from '~/__tests__/i18n';
import type * as Uploads from '../postboxAttachmentUploads';

/**
 * #1273: cancelling an upload chip while `drafts.addAttachment` runs. The
 * mutation commits after the cancel, so the composer must take the file back
 * off the draft rather than re-adding it, and hold Send until it has.
 */

const i18n = createTestI18n();

vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		mail: {
			drafts: {
				get: 'drafts.get',
				addAttachment: 'drafts.addAttachment',
				removeAttachment: 'drafts.removeAttachment',
			},
			draftExpectedAttachments: { fulfil: 'expected.fulfil', remove: 'expected.remove' },
			attachmentSharesActions: {
				shareDraftAttachment: 'attachmentSharesActions.shareDraftAttachment',
			},
		},
	},
}));

// The real state machine; only the XHR is replaced (the bytes are stored at once).
vi.mock('../postboxAttachmentUploads', async (importActual) => ({
	...(await importActual<typeof Uploads>()),
	xhrPutFile: vi.fn(async () => 'storage_salary'),
}));

/** The draft's attachments as the server holds them. */
let draftAttachments: string[];
let releaseAttach: () => void;
let removeAttachment: ReturnType<typeof vi.fn>;

beforeEach(() => {
	draftAttachments = [];
	removeAttachment = vi.fn(async (args: { storageId: string }) => {
		draftAttachments = draftAttachments.filter((s) => s !== args.storageId);
		return { ok: true, result: { ok: true } };
	});
	const ops: Record<string, (args: never) => Promise<unknown>> = {
		'storage.generateUploadUrl': async () => ({ ok: true, result: 'https://upload.example' }),
		// The attach commits only when the test lets it.
		'drafts.addAttachment': (args: { storageId: string }) =>
			new Promise((resolve) => {
				releaseAttach = () => {
					draftAttachments = [...draftAttachments, args.storageId];
					resolve({ ok: true, result: { ok: true } });
				};
			}),
		'drafts.removeAttachment': removeAttachment as never,
	};
	vi.stubGlobal('useBackendOperation', (name: string) => ({
		run: ops[name] ?? vi.fn(async () => ({ ok: false })),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('usePostboxPendingAttachments', () => ({ take: () => null }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined) }));
});

const flush = async () => {
	for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

describe('usePostboxComposeAttachments: cancel while the file attaches', () => {
	it('leaves no chip and no attachment on the draft, and holds Send until then', async () => {
		const { usePostboxComposeAttachments } = await import('../usePostboxComposeAttachments');
		const composer = withSetup(() =>
			usePostboxComposeAttachments({
				ensureDraft: async () => 'draft-1' as never,
				draftId: ref('draft-1' as never),
			})
		).result;

		const file = new File(['x'], 'salary.xlsx', { type: 'application/vnd.ms-excel' });
		await composer.addFiles([file]);
		await flush();
		expect(composer.uploads.value).toHaveLength(1);

		composer.cancelUpload(composer.uploads.value[0]!.id);
		expect(composer.uploads.value).toHaveLength(0);
		expect(composer.isUploading.value).toBe(true);

		// The mutation was already on its way and commits after the cancel.
		releaseAttach();
		await flush();

		expect(removeAttachment).toHaveBeenCalledWith({
			draftId: 'draft-1',
			storageId: 'storage_salary',
		});
		expect(draftAttachments).toEqual([]);
		expect(composer.attachments.value).toEqual([]);
		expect(composer.uploads.value).toEqual([]);
		expect(composer.isUploading.value).toBe(false);
	});
});
