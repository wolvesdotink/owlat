/**
 * Hydrate the composer from a saved draft row (reopen / continue editing /
 * after an undo-send). Split out of usePostboxCompose so that composable stays
 * under the file-size cap; it is only ever set up when the compose seed carries
 * a `draftId`, so a fresh compose never subscribes to `drafts.get`.
 *
 * The composer stays editable while `drafts.get` is in flight, which makes the
 * first answer a MERGE, not an assignment (#896). Every field the user changed
 * before it arrived is recorded as touched, by name — an empty value is not a
 * marker, because clearing a field is an edit too — and keeps the user's value;
 * every other field takes the row's. Until then the state stays 'loading' (or
 * 'error' when the read failed), and the autosave and send paths refuse to
 * write the snapshot, which would carry empty stand-ins for everything not yet
 * loaded. A read that answers "no such row" for longer than a short grace
 * becomes 'missing' and keeps refusing them; only a row that shows up after
 * all (access restored) is merged and unlocks them.
 */

import type { Ref, WatchStopHandle } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import type { ComposerMode } from './usePostboxCompose';
import type { ComposerAttachment } from './usePostboxComposeAttachments';

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
}

/** The fields autosave writes as one snapshot; each is merged on its own. */
const TRACKED_DRAFT_FIELDS = [
	'toAddresses',
	'ccAddresses',
	'bccAddresses',
	'subject',
	'bodyHtml',
	'bodyBlocks',
	'composerMode',
	'followUpRemindAt',
] as const;
export type TrackedDraftField = (typeof TRACKED_DRAFT_FIELDS)[number];

interface HydrationOptions {
	/** Owned by the composer: autosave and send read it too. */
	state: Ref<InitialHydrationState>;
	/**
	 * Fields the seed filled in for this reopened draft. They count as touched:
	 * a host seeds a reopened draft only with content newer than the row (the
	 * live fields of a promoted inline reply, an offline-queued send brought
	 * back by undo), so the row must not replace them.
	 */
	seeded: readonly TrackedDraftField[];
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
	attachments?: Array<{
		storageId: string;
		filename: string;
		contentType: string;
		size: number;
	}>;
};

export function usePostboxComposeHydration(
	draftId: Id<'mailDrafts'>,
	fields: ComposeHydrationTargets,
	options: HydrationOptions
) {
	const { state } = options;
	const hydrateQuery = useConvexQuery(api.mail.drafts.get, () => ({ draftId }));
	const touched = new Set<TrackedDraftField>(options.seeded);
	let applying = false;

	// Synchronous, so an edit is recorded before anything else can react to it.
	const stopTracking: WatchStopHandle[] = TRACKED_DRAFT_FIELDS.map((name) =>
		watch(
			fields[name],
			() => {
				if (applying || state.value === 'ready') return;
				touched.add(name);
				// Body text is judged in the mode it was typed in: letting the row's
				// mode win would hide a simple-mode edit behind a full-mode design
				// (or the reverse). The row's other body stays in `bodyBlocks` /
				// `bodyHtml`, one mode switch away, and is not overwritten — a
				// simple-mode save leaves `bodyBlocks` alone on the server.
				if (name === 'bodyHtml' || name === 'bodyBlocks') touched.add('composerMode');
			},
			{ deep: true, flush: 'sync' }
		)
	);

	function apply(draft: DraftRow) {
		const keep = (name: TrackedDraftField) => touched.has(name);
		fields.draftState.value = draft.state ?? 'draft';
		if (draft.lastEditedAt) fields.lastSavedAt.value = draft.lastEditedAt;
		fields.scheduledSendAt.value = draft.scheduledSendAt ?? null;
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
		[() => hydrateQuery.data.value, () => hydrateQuery.error.value],
		([d, error]) => {
			if (state.value === 'ready') return;
			if (error && !d) {
				clearMissingTimer();
				state.value = 'error';
				return;
			}
			if (d === null) {
				// Still waiting until the answer has stood for the grace period.
				if (state.value === 'missing' || missingTimer) return;
				state.value = 'loading';
				missingTimer = setTimeout(() => {
					missingTimer = null;
					if (state.value === 'loading') state.value = 'missing';
				}, DRAFT_MISSING_GRACE_MS);
				return;
			}
			clearMissingTimer();
			if (!d) {
				state.value = 'loading';
				return;
			}
			applying = true;
			try {
				apply(d as DraftRow);
			} finally {
				applying = false;
			}
			for (const stop of stopTracking) stop();
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
