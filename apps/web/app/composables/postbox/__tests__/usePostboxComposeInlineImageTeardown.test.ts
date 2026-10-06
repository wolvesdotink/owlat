import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { ref } from 'vue';
import { withSetup } from '~/__tests__/withSetup';
import { createTestI18n } from '~/__tests__/i18n';

/**
 * #1285: a pasted image whose upload finishes after its composer closed is not
 * attached to that composer's draft. The upload stays an unbound receipt,
 * which expires and is deleted by the abandoned-uploads sweep
 * (`storage/uploads.ts` `cleanup`), so nothing is left on any draft.
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
			draftExpectedAttachments: { remove: 'expected.remove' },
			draftExpectedAttachmentsFulfil: { fulfil: 'expected.fulfil' },
			attachmentSharesActions: {
				shareDraftAttachment: 'attachmentSharesActions.shareDraftAttachment',
			},
		},
	},
}));

let addAttachment: ReturnType<typeof vi.fn>;
let finishUpload: () => void;
const originalFetch = globalThis.fetch;

beforeEach(() => {
	addAttachment = vi.fn(async () => ({ ok: true, result: { ok: true } }));
	const ops: Record<string, (args: never) => Promise<unknown>> = {
		'storage.generateUploadUrl': () =>
			Promise.resolve({ ok: true, result: 'https://upload.example' }),
		'drafts.addAttachment': addAttachment as never,
	};
	vi.stubGlobal('useBackendOperation', (name: string) => ({
		run: ops[name] ?? vi.fn(async () => ({ ok: false })),
		isLoading: ref(false),
	}));
	vi.stubGlobal('useToast', () => ({ showToast: vi.fn() }));
	vi.stubGlobal('useI18n', () => i18n.global);
	vi.stubGlobal('usePostboxPendingAttachments', () => ({ take: () => null }));
	vi.stubGlobal('useConvexQuery', () => ({ data: ref(undefined) }));
	// The upload POST answers only when the test lets it.
	globalThis.fetch = vi.fn(
		() =>
			new Promise<Response>((resolve) => {
				finishUpload = () =>
					resolve(new Response(JSON.stringify({ storageId: 'storage_late' }), { status: 200 }));
			})
	) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

const flush = async () => {
	for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 0));
};

describe('usePostboxComposeAttachments: an inline image upload that outlives its composer', () => {
	it('attaches nothing once the composer has closed', async () => {
		const { usePostboxComposeAttachments } = await import('../usePostboxComposeAttachments');
		const { result: composer, unmount } = withSetup(() =>
			usePostboxComposeAttachments({
				ensureDraft: async () => 'draft-a' as never,
				draftId: ref('draft-a' as never),
			})
		);

		const pending = composer.addInlineImage(
			new File([new Uint8Array([1, 2, 3])], 'chart.png', { type: 'image/png' })
		);
		await flush();
		unmount();
		finishUpload();

		expect(await pending).toBeNull();
		expect(addAttachment).not.toHaveBeenCalled();
	});

	it('still attaches an upload that finishes while the composer is open', async () => {
		const { usePostboxComposeAttachments } = await import('../usePostboxComposeAttachments');
		const { result: composer } = withSetup(() =>
			usePostboxComposeAttachments({
				ensureDraft: async () => 'draft-a' as never,
				draftId: ref('draft-a' as never),
			})
		);
		vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:chart' }));

		const pending = composer.addInlineImage(
			new File([new Uint8Array([1, 2, 3])], 'chart.png', { type: 'image/png' })
		);
		await flush();
		finishUpload();

		expect((await pending)?.previewUrl).toBe('blob:chart');
		expect(addAttachment).toHaveBeenCalledWith(
			expect.objectContaining({ draftId: 'draft-a', storageId: 'storage_late', isInline: true })
		);
	});
});
