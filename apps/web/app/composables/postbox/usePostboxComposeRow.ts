/**
 * The composer's row state, wired in one place: the shared touched-field
 * tracker, the live observation of the draft row (`latestRow`), and hydration
 * (merging a reopened row into the editor), plus the two things the compose
 * page needs from them: what to park on a leave (`parkable`) and a way to merge
 * parked text before the composer turns ready (`BeforeReady`). Split out of
 * `usePostboxCompose` for the file-size ratchet; the composer owns every ref
 * passed in.
 */

import { ref, shallowRef, type Ref } from 'vue';
import type { Id } from '@owlat/api/dataModel';
import type { EditorBlock } from '@owlat/email-builder';
import {
	MIRROR_FIELD_NAMES,
	applyMirrorFields,
	mirrorFieldEqual,
	mirrorFieldsOf,
	type MirrorFieldName,
	type MirrorFields,
} from '~/utils/postboxDraftMirror';
import type { ComposerMode, ComposerSeed } from './usePostboxCompose';
import type { ComposerAttachment } from './usePostboxComposeAttachments';
import {
	usePostboxComposeHydration,
	type InitialHydrationState,
	type LatestDraftRow,
} from './usePostboxComposeHydration';
import {
	usePostboxComposeTouched,
	type ComposeTouched,
	type TrackedComposeField,
} from './usePostboxComposeTouched';

interface RowFields {
	toAddresses: Ref<string[]>;
	ccAddresses: Ref<string[]>;
	bccAddresses: Ref<string[]>;
	subject: Ref<string>;
	bodyHtml: Ref<string>;
	bodyBlocks: Ref<EditorBlock[]>;
	composerMode: Ref<ComposerMode>;
	followUpRemindAt: Ref<number | null>;
	fromAddress: Ref<string>;
	draftState: Ref<'draft' | 'pending_send' | 'scheduled'>;
	scheduledSendAt: Ref<number | null>;
	attachments: Ref<ComposerAttachment[]>;
	lastSavedAt: Ref<number | null>;
	isGapGuarded: Ref<boolean>;
}

/** What the compose page parks when it is left with text the server may not hold. */
export interface ParkableSnapshot {
	fields: MirrorFields;
	/**
	 * The fields that are real: all of them once the row has loaded (or there
	 * is none to load); before that, only those the seed or the person set.
	 */
	present: MirrorFieldName[];
	/** The row as last observed; null when none has loaded. */
	base: MirrorFields | null;
	draftId: Id<'mailDrafts'> | null;
	ready: boolean;
}

/** Handed to a host's `beforeReady`, to merge text it parked earlier. */
export interface BeforeReadyContext {
	/**
	 * Put `names` of `fields` into the editor without marking them touched.
	 * Applies nothing and returns false when one of them was changed during
	 * this mount to a different value (the person's newer edit stays).
	 */
	merge: (fields: MirrorFields, names: readonly MirrorFieldName[]) => boolean;
}

/**
 * Runs once a reopened row has loaded and merged, before the composer turns
 * ready (nothing has been autosaved over the row yet).
 */
export type BeforeReady = (row: MirrorFields, context: BeforeReadyContext) => void;

/** The seed keys that pre-fill a tracked field, in field order. */
function seededFields(seed: ComposerSeed): TrackedComposeField[] {
	const supplied: [TrackedComposeField, unknown][] = [
		['toAddresses', seed.prefillTo],
		['ccAddresses', seed.prefillCc],
		['bccAddresses', seed.prefillBcc],
		['subject', seed.prefillSubject],
		['bodyHtml', seed.prefillBodyHtml],
		['bodyBlocks', seed.prefillBodyBlocks],
		['composerMode', seed.prefillComposerMode],
		['followUpRemindAt', seed.prefillFollowUpRemindAt],
	];
	return supplied.flatMap(([name, value]) => (value === undefined ? [] : [name]));
}

/** The shared touched-field tracker, seeded from what the seed supplies. */
export function usePostboxComposeSeedTouched(
	seed: ComposerSeed,
	fields: Pick<RowFields, TrackedComposeField>
): ComposeTouched {
	return usePostboxComposeTouched(
		{
			toAddresses: fields.toAddresses,
			ccAddresses: fields.ccAddresses,
			bccAddresses: fields.bccAddresses,
			subject: fields.subject,
			bodyHtml: fields.bodyHtml,
			bodyBlocks: fields.bodyBlocks,
			composerMode: fields.composerMode,
			followUpRemindAt: fields.followUpRemindAt,
		},
		seededFields(seed)
	);
}

export function usePostboxComposeRow(
	seed: ComposerSeed,
	draftId: Ref<Id<'mailDrafts'> | null>,
	initialHydration: Ref<InitialHydrationState>,
	fields: RowFields,
	touched: ComposeTouched,
	beforeReady?: BeforeReady
) {
	// Shallow: each answer is a fresh plain snapshot, stored on-device as is
	// (IndexedDB cannot clone a reactive proxy).
	const latestRow = shallowRef<LatestDraftRow>({ status: 'unknown' });

	function merge(parked: MirrorFields, names: readonly MirrorFieldName[]): boolean {
		const now = mirrorFieldsOf(fields);
		if (names.some((name) => touched.isTouched(name) && !mirrorFieldEqual(name, now, parked))) {
			return false;
		}
		touched.applying(() => applyMirrorFields(fields, parked, names));
		return true;
	}

	// A reopened draft is merged; so is a row a request nonce turns out to name.
	const mergeRow = ref(Boolean(seed.draftId));
	const hydration = usePostboxComposeHydration(draftId, fields, {
		state: initialHydration,
		touched,
		shouldMerge: () => mergeRow.value,
		latestRow,
		beforeReady: beforeReady ? (rowFields) => beforeReady(rowFields, { merge }) : undefined,
	});

	/** What to park on a leave, read synchronously from the refs. */
	function parkable(): ParkableSnapshot {
		const ready = initialHydration.value === 'ready';
		const row = latestRow.value;
		return {
			fields: mirrorFieldsOf(fields),
			present: ready ? [...MIRROR_FIELD_NAMES] : touched.list(),
			base: row.status === 'loaded' ? row.fields : null,
			draftId: draftId.value,
			ready,
		};
	}

	return {
		latestRow,
		hydration,
		parkable,
		/**
		 * The nonce named an existing row: merge it like a reopened draft. The
		 * row was made from the seed, so only this mount's edits win over it.
		 */
		reopenExisting: () => {
			touched.forgetSeeded();
			mergeRow.value = true;
			initialHydration.value = 'loading';
		},
	};
}
