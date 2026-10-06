/**
 * The files on a Team inbox reply (`inbox.replyAttachments`): what the
 * composer has attached so far, uploads in flight, and the file the agent
 * matched to what the customer asked for.
 *
 * The list lives on the thread, so a teammate opening the same thread sees the
 * same files, and a send takes them. Three ways in:
 *  - an upload: the bytes go to a fresh storage URL, then `add` binds the
 *    upload to the thread (with the file's name, which the blob does not know);
 *  - an existing file (Files, the agent's suggestion, a file answer): `attachExisting`
 *    lists it as `copying` while the server copies the bytes into a blob the
 *    reply owns, then `ready`;
 *  - nothing is ever attached on its own: the agent's suggestion waits for a
 *    person to pick it.
 *
 * A send waits while a copy runs or failed (`approveDraft` refuses then too),
 * so `blocking` says why Send is held.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { FunctionReturnType } from 'convex/server';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import {
	createAttachmentUploads,
	xhrPutFile,
} from '~/composables/postbox/postboxAttachmentUploads';

export type TeamReplyAttachmentView = FunctionReturnType<
	typeof api.inbox.replyAttachments.list
>[number];
export type TeamAttachSuggestion = NonNullable<
	FunctionReturnType<typeof api.inbox.replyAttachments.suggestions>
>;

/** Why Send waits on the attachments, or null. */
export type TeamAttachmentBlock = 'uploading' | 'copying' | 'failed' | null;

export function useTeamReplyAttachments(
	threadId: () => Id<'conversationThreads'> | null,
	opts: { enabled?: () => boolean } = {}
) {
	const { t, locale } = useI18n();
	const { showToast } = useToast();
	const args = () => {
		const id = threadId();
		return id && (opts.enabled?.() ?? true) ? { threadId: id } : ('skip' as const);
	};

	const { data: listData } = useConvexQuery(api.inbox.replyAttachments.list, args);
	const { data: suggestionData } = useConvexQuery(api.inbox.replyAttachments.suggestions, args);
	/** The server's answer to the last write, until the subscription catches up. */
	const written = ref<TeamReplyAttachmentView[] | null>(null);
	watch(listData, () => {
		written.value = null;
	});
	const attachments = computed<TeamReplyAttachmentView[]>(
		() => written.value ?? listData.value ?? []
	);
	const suggestion = computed<TeamAttachSuggestion | null>(() => suggestionData.value ?? null);

	const generateUploadUrl = useBackendOperation(api.storage.generateUploadUrl, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.prepareUploadOperation'),
	});
	const addOp = useBackendOperation(api.inbox.replyAttachments.add, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.attachOperation'),
	});
	const attachExistingOp = useBackendOperation(api.inbox.replyAttachments.attachExisting, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.attachOperation'),
	});
	const removeOp = useBackendOperation(api.inbox.replyAttachments.remove, {
		label: () => t('shared.postbox.usePostboxComposeAttachments.removeOperation'),
	});

	// The thread and list entry each upload was bound to, by storageId, so a
	// cancelled upload whose `add` still went through can be taken off again.
	const bound = new Map<
		string,
		{ threadId: Id<'conversationThreads'>; entry: { index: number; id: string } }
	>();
	const uploader = createAttachmentUploads({
		generateUploadUrl: async () => {
			const minted = await generateUploadUrl.run({});
			return minted.ok ? minted.result : null;
		},
		putFile: xhrPutFile,
		attach: async (a) => {
			const id = threadId();
			if (!id) return false;
			const result = await addOp.run({
				threadId: id,
				storageId: a.storageId as Id<'_storage'>,
				filename: a.filename,
				contentType: a.contentType,
			});
			if (!result.ok) return false;
			written.value = result.result;
			// `add` appends the upload, so it is the list's last entry.
			const entry = result.result.at(-1);
			if (entry) bound.set(a.storageId, { threadId: id, entry });
			return true;
		},
		detach: async (a) => {
			const binding = bound.get(a.storageId);
			if (!binding) return false;
			const result = await removeOp.run({
				threadId: binding.threadId,
				index: binding.entry.index,
				id: binding.entry.id,
			});
			if (!result.ok) return false;
			bound.delete(a.storageId);
			if (threadId() === binding.threadId) written.value = result.result;
			return true;
		},
		// The committed file arrives through the list; the thumbnail is not kept.
		onCommitted: (a) => {
			bound.delete(a.storageId);
		},
		createThumb: () => null,
	});
	onBeforeUnmount(() => uploader.dispose());

	const formatMb = (bytes: number) =>
		new Intl.NumberFormat(locale.value).format(bytes / 1024 / 1024);

	/** Upload `files`, refusing up front what the server would refuse. */
	function addFiles(files: File[] | FileList) {
		let count = attachments.value.length + uploader.uploads.value.length;
		let total =
			attachments.value.reduce((sum, a) => sum + a.size, 0) +
			uploader.uploads.value.reduce((sum, c) => sum + c.size, 0);
		const accepted: File[] = [];
		for (const file of Array.from(files)) {
			if (file.size > MAX_ATTACHMENT_BYTES) {
				showToast(
					t('shared.postbox.usePostboxComposeAttachments.tooLarge', {
						filename: file.name,
						max: formatMb(MAX_ATTACHMENT_BYTES),
					}),
					'error'
				);
				continue;
			}
			if (count + 1 > ATTACHMENT_COMPOSE_LIMITS.maxCount) {
				showToast(
					t('shared.postbox.usePostboxComposeAttachments.tooManyFiles', {
						count: ATTACHMENT_COMPOSE_LIMITS.maxCount,
					}),
					'error'
				);
				break;
			}
			if (total + file.size > ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) {
				showToast(
					t('shared.postbox.usePostboxComposeAttachments.totalTooLarge', {
						max: formatMb(ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes),
					}),
					'error'
				);
				break;
			}
			count += 1;
			total += file.size;
			accepted.push(file);
		}
		if (accepted.length > 0) uploader.addFiles(accepted);
	}

	/** Attach a file from Files or a received email (copied server-side). */
	async function attachExisting(source: 'semanticFile' | 'mailAttachment', id: string) {
		const thread = threadId();
		if (!thread) return false;
		const result = await attachExistingOp.run({ threadId: thread, source, id });
		if (result.ok) written.value = result.result;
		return result.ok;
	}

	/**
	 * Attach a file an answer named: a Files row or a received attachment is
	 * copied; an upload kept out of Files is bound as it is.
	 */
	async function attachAnswerFile(file: {
		source: 'upload' | 'semanticFile' | 'mailAttachment';
		id: string;
		filename: string;
	}) {
		if (file.source !== 'upload') return attachExisting(file.source, file.id);
		const thread = threadId();
		if (!thread) return false;
		const result = await addOp.run({
			threadId: thread,
			storageId: file.id as Id<'_storage'>,
			filename: file.filename,
		});
		if (result.ok) written.value = result.result;
		return result.ok;
	}

	/**
	 * Remove the file shown at `index`. Its id goes along, so a teammate's edit
	 * that shifts the list before this lands cannot make it take another file.
	 */
	async function remove(index: number) {
		const thread = threadId();
		if (!thread) return false;
		const id = attachments.value[index]?.id;
		const result = await removeOp.run({ threadId: thread, index, ...(id ? { id } : {}) });
		if (result.ok) written.value = result.result;
		return result.ok;
	}

	const block = computed<TeamAttachmentBlock>(() => {
		if (uploader.isUploading.value) return 'uploading';
		if (attachments.value.some((a) => a.status === 'failed')) return 'failed';
		if (attachments.value.some((a) => a.status === 'copying')) return 'copying';
		return null;
	});

	return {
		attachments,
		uploads: uploader.uploads,
		suggestion,
		block,
		addFiles,
		attachExisting,
		attachAnswerFile,
		remove,
		cancelUpload: uploader.cancel,
		retryUpload: uploader.retry,
	};
}
