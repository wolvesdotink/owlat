/**
 * Hydrate the composer from a saved draft row (reopen / continue editing /
 * after an undo-send). Split out of usePostboxCompose so that composable stays
 * under the file-size cap; it is only ever set up when the compose seed carries
 * a `draftId`, so a fresh compose never subscribes to `drafts.get`.
 */

import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { ComposerMode } from './usePostboxCompose';
import type { ComposerAttachment } from './usePostboxComposeAttachments';

/** The composer fields hydration fills in, all owned by usePostboxCompose. */
interface ComposeHydrationTargets {
	toAddresses: Ref<string[]>;
	ccAddresses: Ref<string[]>;
	bccAddresses: Ref<string[]>;
	subject: Ref<string>;
	bodyHtml: Ref<string>;
	bodyBlocks: Ref<EditorBlock[]>;
	fromAddress: Ref<string>;
	composerMode: Ref<ComposerMode>;
	draftState: Ref<'draft' | 'pending_send' | 'scheduled'>;
	scheduledSendAt: Ref<number | null>;
	followUpRemindAt: Ref<number | null>;
	attachments: Ref<ComposerAttachment[]>;
	/**
	 * When the SERVER last saved this row. Filled from `lastEditedAt` so a
	 * reopened draft reports a real "Saved at …" instead of a blank until its
	 * first autosave — and so the local draft mirror (plan idea 7) has a server
	 * clock to reconcile against the moment hydration lands.
	 */
	lastSavedAt: Ref<number | null>;
}

export function usePostboxComposeHydration(
	draftId: Id<'mailDrafts'>,
	fields: ComposeHydrationTargets
) {
	const hydrateQuery = useConvexQuery(api.mail.drafts.get, () => ({ draftId }));
	let hydrated = false;
	watch(
		() => hydrateQuery.data.value,
		(d) => {
			if (hydrated || !d) return;
			hydrated = true;
			const draft = d as {
				toAddresses?: string[];
				ccAddresses?: string[];
				bccAddresses?: string[];
				subject?: string;
				bodyHtml?: string;
				bodyBlocks?: string;
				fromAddress?: string;
				composerMode?: ComposerMode;
				state?: 'draft' | 'pending_send' | 'scheduled';
				scheduledSendAt?: number;
				followUpRemindAt?: number;
				lastEditedAt?: number;
				attachments?: Array<{
					storageId: string;
					filename: string;
					contentType: string;
					size: number;
				}>;
			};
			fields.draftState.value = draft.state ?? 'draft';
			if (draft.lastEditedAt) fields.lastSavedAt.value = draft.lastEditedAt;
			fields.scheduledSendAt.value = draft.scheduledSendAt ?? null;
			if (fields.followUpRemindAt.value === null) {
				fields.followUpRemindAt.value = draft.followUpRemindAt ?? null;
			}
			// Fill only fields the user hasn't already touched: the composer is
			// editable while drafts.get is in flight, so unconditional assignment
			// would clobber (and then autosave away) edits typed in the gap.
			if (fields.toAddresses.value.length === 0) {
				fields.toAddresses.value = draft.toAddresses ?? [];
			}
			if (fields.ccAddresses.value.length === 0) {
				fields.ccAddresses.value = draft.ccAddresses ?? [];
			}
			if (fields.bccAddresses.value.length === 0) {
				fields.bccAddresses.value = draft.bccAddresses ?? [];
			}
			if (!fields.subject.value) fields.subject.value = draft.subject ?? '';
			if (!fields.bodyHtml.value) fields.bodyHtml.value = draft.bodyHtml ?? '';
			if (!fields.fromAddress.value && draft.fromAddress) {
				fields.fromAddress.value = draft.fromAddress;
			}
			if (draft.composerMode) fields.composerMode.value = draft.composerMode;
			if (fields.bodyBlocks.value.length === 0 && draft.bodyBlocks) {
				try {
					fields.bodyBlocks.value = JSON.parse(draft.bodyBlocks) as EditorBlock[];
				} catch {
					// Leave empty on malformed JSON.
				}
			}
			if (fields.attachments.value.length === 0) {
				fields.attachments.value = (draft.attachments ?? []).map((a) => ({
					storageId: a.storageId,
					filename: a.filename,
					contentType: a.contentType,
					size: a.size,
				}));
			}
		},
		{ immediate: true }
	);
}
