import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ref, nextTick, type Ref } from 'vue';

/**
 * Regression: pressing Send while an attachment upload is still in flight must be
 * blocked. The draft's `attachments` array has not yet committed the pending
 * file, so a mid-upload send would transition to pending_send and dispatch the
 * message WITHOUT the not-yet-uploaded attachment — the recipient silently loses
 * it. `canSend` must fold in `isUploading` (mirroring the chat composer), so both
 * the Send button's disabled state and the handleSend / Cmd-Enter guard gate on
 * it. Once the upload settles, `canSend` returns true again and the send fires.
 */

vi.mock('@owlat/api', () => ({
	api: {
		mail: {
			drafts: {
				get: 'drafts.get',
				create: 'drafts.create',
				update: 'drafts.update',
				setIdentity: 'drafts.setIdentity',
				discard: 'drafts.discard',
				send: 'drafts.send',
				cancelPendingSend: 'drafts.cancelPendingSend',
				cancelScheduledSend: 'drafts.cancelScheduledSend',
			},
			identities: { listForOwnedMailbox: 'identities.list' },
			signatures: { list: 'signatures.list' },
		},
	},
}));

// Controllable upload state shared with the mocked attachments sibling.
const isUploading = ref(false);
const attachments = ref<Array<{ storageId: string; filename: string }>>([]);

vi.mock('../usePostboxComposeAttachments', () => ({
	usePostboxComposeAttachments: () => ({
		attachments,
		uploads: ref([]),
		isUploading,
		attachmentSizeMeter: ref(null),
		thumbUrlFor: () => '',
		addFiles: () => {},
		removeAttachment: () => {},
		cancelUpload: () => {},
		retryUpload: () => {},
		addInlineImage: () => {},
		removeInlineImage: () => {},
	}),
}));

let hydrateData: Ref<unknown>;
let signaturesData: Ref<unknown>;
let identitiesData: Ref<unknown>;
let sendRun: ReturnType<typeof vi.fn>;

beforeEach(() => {
	isUploading.value = false;
	attachments.value = [];
	hydrateData = ref(undefined);
	signaturesData = ref([]);
	identitiesData = ref([]);

	vi.stubGlobal('useConvexQuery', (fn: unknown) => {
		if (fn === 'drafts.get') return { data: hydrateData };
		if (fn === 'signatures.list') return { data: signaturesData };
		if (fn === 'identities.list') return { data: identitiesData };
		return { data: ref(undefined) };
	});

	sendRun = vi.fn(async () => undefined);
	vi.stubGlobal('useBackendOperation', (fn: unknown) => {
		if (fn === 'drafts.send') return { run: sendRun };
		if (fn === 'drafts.create') return { run: vi.fn(async () => ({ draftId: 'draft-new' })) };
		return { run: vi.fn(async () => undefined) };
	});
});

async function loadComposable() {
	const mod = await import('../usePostboxCompose');
	return mod.usePostboxCompose;
}

describe('usePostboxCompose — send blocked while uploading', () => {
	it('canSend is false while an attachment is still uploading', async () => {
		const usePostboxCompose = await loadComposable();
		const composer = usePostboxCompose({ mailboxId: 'mbx-1' as never });

		composer.toAddresses.value = ['someone@example.com'];
		composer.subject.value = 'Here is the file';
		// A committed attachment plus content would normally allow send…
		attachments.value = [{ storageId: 's1', filename: 'a.pdf' }];
		await nextTick();
		expect(composer.canSend.value).toBe(true);

		// …but the moment another upload is in flight, Send must be gated.
		isUploading.value = true;
		await nextTick();
		expect(composer.canSend.value).toBe(false);
	});

	it('re-enables send and dispatches once the upload settles', async () => {
		const usePostboxCompose = await loadComposable();
		const composer = usePostboxCompose({ mailboxId: 'mbx-1' as never });

		composer.toAddresses.value = ['someone@example.com'];
		composer.subject.value = 'Here is the file';
		isUploading.value = true;
		await nextTick();
		expect(composer.canSend.value).toBe(false);

		// Upload finishes and commits its attachment.
		isUploading.value = false;
		attachments.value = [{ storageId: 's1', filename: 'a.pdf' }];
		await nextTick();
		expect(composer.canSend.value).toBe(true);

		// A real send now reaches the backend with the committed attachment.
		sendRun.mockResolvedValueOnce({ undoToken: 'tok', sendAt: 123 });
		const result = await composer.send();
		expect(sendRun).toHaveBeenCalledOnce();
		expect(result).toEqual({ undoToken: 'tok', sendAt: 123 });
	});
});
