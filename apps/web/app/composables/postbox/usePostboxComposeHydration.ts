/**
 * The composer's view of its draft row: hydration of a reopened draft, and a
 * live observation of the row for as long as the composer has one.
 *
 * Subscribes to `drafts.get` whenever the composer has a draft id (a reopened
 * draft, a row created during this mount, or a request nonce that turned out
 * to name an existing row). Two jobs:
 *
 *   - MERGE (reopen only): the composer stays editable while `drafts.get` is
 *     in flight, which makes the first answer a merge, not an assignment
 *     (#896). Every field the person changed before it arrived is touched (the
 *     shared tracker, `usePostboxComposeTouched`) and keeps their value; every
 *     other field takes the row's. Until then the state stays 'loading' (or
 *     'error' when the read failed), and autosave and send refuse to write a
 *     snapshot full of empty stand-ins. A read that answers "no such row" for
 *     longer than a short grace becomes 'missing'.
 *   - OBSERVE (always): `latestRow` follows every answer, normalized for the
 *     device mirror, and the row's lifecycle (state, scheduled time) stays
 *     current after the merge, so a remote schedule or delete is seen.
 */

import type { Ref } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { ComposerMode } from './usePostboxCompose';
import type { ComposerAttachment } from './usePostboxComposeAttachments';
import { mirrorFieldsOfRow, type MirrorFields } from '~/utils/postboxDraftMirror';
import type { ComposeTouched } from './usePostboxComposeTouched';

/**
 * Whether a reopened draft's row has reached the composer yet. 'missing' means
 * the read answered that there is no row this member can open (deleted, or
 * access lost): nothing will ever load, so nothing may be written or sent.
 */
export type InitialHydrationState = 'loading' | 'ready' | 'error' | 'missing';

/**
 * How long a "no such row" answer must stand before the composer calls the
 * draft missing. The composer only mounts behind auth, so a `null` is almost
 * always final; the grace absorbs a soft-auth query answering once before the
 * session token reaches the socket, which is then followed by the real row.
 */
const DRAFT_MISSING_GRACE_MS = 1000;

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
	/**
	 * An AI text with `[[...]]` gaps went into this draft before (the server's
	 * `isGapGuarded`), so its gaps keep holding Send after a reload.
	 */
	isGapGuarded: Ref<boolean>;
}

/**
 * The composer's latest knowledge of its row: not yet known (no id, or the
 * read has not answered), confirmed gone, or loaded.
 */
export type LatestDraftRow =
	| { status: 'unknown' }
	| { status: 'missing' }
	| {
			status: 'loaded';
			fields: MirrorFields;
			state: 'draft' | 'pending_send' | 'scheduled';
			lastEditedAt: number | null;
	  };

interface HydrationOptions {
	/** Owned by the composer: autosave and send read it too. */
	state: Ref<InitialHydrationState>;
	/** The shared touched-field tracker; the merge keeps touched fields. */
	touched: ComposeTouched;
	/**
	 * Whether the first loaded row is merged into the editor: a reopened draft,
	 * or a nonce that named an existing row. A row created during this mount is
	 * only observed (the editor already holds what it was created from).
	 */
	shouldMerge: () => boolean;
	/** Receives every answer, normalized. */
	latestRow: Ref<LatestDraftRow>;
	/**
	 * Runs after the merge and before the state turns 'ready': the compose page
	 * decides here whether text it parked on an earlier leave is applied or
	 * offered (it must not be autosaved over the row before that decision).
	 * Applying fields there is the caller's business (outside `applying`).
	 */
	beforeReady?: (row: MirrorFields) => void;
}

type DraftRow = {
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
	isGapGuarded?: boolean;
	attachments?: Array<{
		storageId: string;
		filename: string;
		contentType: string;
		size: number;
	}>;
};

export function usePostboxComposeHydration(
	draftId: Readonly<Ref<Id<'mailDrafts'> | null>>,
	fields: ComposeHydrationTargets,
	options: HydrationOptions
) {
	const { state, touched, latestRow } = options;
	const hydrateQuery = useConvexQuery(api.mail.drafts.get, () =>
		draftId.value ? { draftId: draftId.value } : ('skip' as const)
	);

	function apply(draft: DraftRow) {
		const keep = (name: Parameters<ComposeTouched['isTouched']>[0]) => touched.isTouched(name);
		fields.draftState.value = draft.state ?? 'draft';
		if (draft.lastEditedAt) fields.lastSavedAt.value = draft.lastEditedAt;
		fields.scheduledSendAt.value = draft.scheduledSendAt ?? null;
		if (draft.isGapGuarded) fields.isGapGuarded.value = true;
		if (!keep('followUpRemindAt')) fields.followUpRemindAt.value = draft.followUpRemindAt ?? null;
		if (!keep('toAddresses')) fields.toAddresses.value = draft.toAddresses ?? [];
		if (!keep('ccAddresses')) fields.ccAddresses.value = draft.ccAddresses ?? [];
		if (!keep('bccAddresses')) fields.bccAddresses.value = draft.bccAddresses ?? [];
		if (!keep('subject')) fields.subject.value = draft.subject ?? '';
		if (!keep('bodyHtml')) fields.bodyHtml.value = draft.bodyHtml ?? '';
		if (!keep('composerMode') && draft.composerMode) {
			fields.composerMode.value = draft.composerMode;
		}
		if (!keep('bodyBlocks') && draft.bodyBlocks) {
			try {
				fields.bodyBlocks.value = JSON.parse(draft.bodyBlocks) as EditorBlock[];
			} catch {
				// Leave empty on malformed JSON.
			}
		}
		// Not part of the autosaved snapshot (each has its own targeted write),
		// so a value already present simply stays.
		if (!fields.fromAddress.value && draft.fromAddress) {
			fields.fromAddress.value = draft.fromAddress;
		}
		if (fields.attachments.value.length === 0) {
			fields.attachments.value = (draft.attachments ?? []).map((a) => ({
				storageId: a.storageId,
				filename: a.filename,
				contentType: a.contentType,
				size: a.size,
			}));
		}
	}

	let missingTimer: ReturnType<typeof setTimeout> | null = null;
	function clearMissingTimer() {
		if (missingTimer) clearTimeout(missingTimer);
		missingTimer = null;
	}
	onScopeDispose(clearMissingTimer);

	watch(
		[() => draftId.value, () => hydrateQuery.data.value, () => hydrateQuery.error.value],
		([id, d, error]) => {
			if (!id) {
				clearMissingTimer();
				latestRow.value = { status: 'unknown' };
				return;
			}
			if (error && !d) {
				clearMissingTimer();
				latestRow.value = { status: 'unknown' };
				if (state.value !== 'ready' && options.shouldMerge()) state.value = 'error';
				return;
			}
			if (d === null) {
				// "No such row" counts only once it has stood for the grace period.
				if (missingTimer || latestRow.value.status === 'missing') return;
				if (state.value !== 'ready' && options.shouldMerge()) state.value = 'loading';
				missingTimer = setTimeout(() => {
					missingTimer = null;
					latestRow.value = { status: 'missing' };
					if (state.value === 'loading' && options.shouldMerge()) state.value = 'missing';
				}, DRAFT_MISSING_GRACE_MS);
				return;
			}
			clearMissingTimer();
			if (!d) {
				if (state.value !== 'ready' && options.shouldMerge()) state.value = 'loading';
				return;
			}
			const row = d as DraftRow;
			const rowFields = mirrorFieldsOfRow(row);
			latestRow.value = {
				status: 'loaded',
				fields: rowFields,
				state: row.state ?? 'draft',
				lastEditedAt: row.lastEditedAt ?? null,
			};
			if (state.value === 'ready' || !options.shouldMerge()) {
				// Lifecycle stays current after the merge (a remote schedule).
				fields.draftState.value = row.state ?? 'draft';
				fields.scheduledSendAt.value = row.scheduledSendAt ?? null;
				return;
			}
			touched.applying(() => apply(row));
			options.beforeReady?.(rowFields);
			state.value = 'ready';
		},
		{ immediate: true }
	);

	/** Read the row again after a failed load ("Try again"). */
	function retry() {
		hydrateQuery.refetch();
	}

	return { retry };
}
