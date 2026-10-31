import { computed, ref, shallowRef, watch, type Ref } from 'vue';
import type {
	BuilderCollabFocus,
	EditorBlock,
	HistoryState,
	ImageUploadResult,
} from '@owlat/email-builder';
import type { CoeditOp } from '@owlat/shared/coeditOps';
import { versionedRef } from '~/lib/versionedRef';
import { useEditorDirtyTracking } from './useEditorDirtyTracking';
import { StaleDraftError } from './useEditorSaveOperation';
import { useOperationErrorToast } from './useOperationErrorToast';
import { useEditorSaveShortcut } from './useEditorSaveShortcut';
import { provideEmailEditorHandlers } from './emailEditorHandlers';
import type { CoeditTarget } from './useEmailCoediting';
import { useEmailEditorCoedit, type EmailEditorCoedit } from './useEmailEditorCoedit';
import { useEmailEditorConflictChoice } from './useEmailEditorConflict';
import { saveLiveSession } from './emailEditorSessionSave';
import {
	useEmailEditorAutosave,
	type EmailEditorAutosave,
	type EmailEditorAutosaveOptions,
} from './useEmailEditorAutosave';

/**
 * Email editor bridge (module) — the app-side owner that backs the
 * `EmailBuilder` component against Convex and runs its edit loop. See
 * CONTEXT.md `## Email editor`.
 *
 * The three editor surfaces (Email template, Transactional email, Saved block)
 * supply only their divergent halves — a per-surface `initialize(source)` parse
 * and `save()` serialize, plus an optional `extraWatch` list for surface-specific
 * dirty-tracked refs. The bridge never branches on which surface it serves.
 *
 * With `coedit`, the email is edited live together with everyone else who
 * has it open: the canvas follows the
 * shared session instead of the row, other people's edits arrive block by
 * block, and Save writes the session. A member who cannot co-edit falls back
 * to the classic draft below.
 */

// ---------------------------------------------------------------------------
// The bridge — composes the upload pipeline above and the dirty tracker
// (useEditorDirtyTracking.ts) with the unsaved-changes guard, the media-picker
// and test-email plumbing, and produces the handler set.
// ---------------------------------------------------------------------------

/** The universal canvas refs the bridge owns and a surface's closures write. */
export interface EmailEditorBridgeContext {
	blocks: Ref<EditorBlock[]>;
	subject: Ref<string>;
	name: Ref<string>;
}

/** The server state a save is built on, frozen when the save starts. */
export interface EmailEditorSaveBase<S> {
	/** The row the draft was hydrated from (translation overlays, languages). */
	source: NonNullable<S> | null;
	/** Its revision, for the backend's concurrent-writer check. */
	revision: number | undefined;
	/**
	 * The co-editing session version this tab has seen. Pass it to the update
	 * mutation: the server then saves the shared session, not the payload.
	 */
	coeditVersion?: number;
	/** A background save: pass it on to the mutation and keep a refusal quiet. */
	autosave?: boolean;
}

export interface EmailEditorBridgeOptions<S> {
	/** The loaded row (template / email / block). */
	source: Ref<S>;
	/** Per-surface parse → sets blocks/subject/name (and page-owned refs). */
	initialize: (source: NonNullable<S>, ctx: EmailEditorBridgeContext) => void;
	/**
	 * Per-surface serialize + mutation. Throw to abort (keeps the editor dirty);
	 * throw `StaleDraftError` when the backend refused a stale revision, which
	 * opens the conflict choice. Resolve with the revision the write stored when
	 * the mutation reports it. Read the draft synchronously before the first
	 * `await`: anything read after it may already include edits made while the
	 * save is in flight.
	 */
	save: (ctx: EmailEditorBridgeContext, base: EmailEditorSaveBase<S>) => Promise<number | void>;
	/**
	 * Surface-specific dirty-tracked refs (e.g. attachments, description).
	 * Refs rather than getters: "keep my version" writes them back when it
	 * merges the draft onto the latest row.
	 */
	extraWatch?: Ref<unknown>[];
	/** The row's editor-content revision; enables the stale-draft check. */
	revision?: (source: NonNullable<S>) => number;
	/**
	 * Whether a draft built on `base` can be saved over `latest` ("keep my
	 * version"). When it cannot, the conflict only offers loading the latest.
	 */
	canKeepDraft?: (base: NonNullable<S>, latest: NonNullable<S>) => boolean;
	/**
	 * Co-edit this email live. `fields` are the surface's shared refs besides
	 * name and subject, by session field name (`plainTextOverride`, ...).
	 */
	coedit?: { target: () => CoeditTarget | null; fields: Record<string, Ref<unknown>> };
	/** Save the draft in the background (useEmailEditorAutosave.ts) while `enabled`. */
	autosave?: EmailEditorAutosaveOptions;
}

/** What the bridge uses of the mounted EmailBuilder (its exposed API). */
export interface EmailBuilderHandle {
	/** The explicit load path for a hydrated state. */
	loadState: (state: HistoryState) => void;
	/** Text is being typed that the blocks do not hold until the editor closes. */
	readonly isInlineEditing?: boolean;
	/** Select a Block (root or nested) and scroll to it; false when it is gone. */
	selectBlock?: (blockId: string) => boolean;
	/** Apply other people's edits, keeping selection and undo history. */
	applyRemoteOps?: (ops: CoeditOp<EditorBlock>[]) => void;
	/** Close the inline text editor, committing its text to the blocks. */
	commitInlineEdit?: () => void;
}

/** A save the backend refused because the email moved on after the draft loaded. */
export interface EmailEditorConflict {
	/** The revision the server was at when it refused the save. */
	currentRevision: number;
	/**
	 * Set once "keep my version" found the draft cannot be saved over the
	 * latest row (`canKeepDraft`); loading the latest is the only way on.
	 */
	mustReload?: true;
}

export interface EmailEditorBridgeReturn {
	// Universal canvas state (v-model into EmailBuilder).
	blocks: Ref<EditorBlock[]>;
	subject: Ref<string>;
	name: Ref<string>;
	isSaving: Ref<boolean>;
	hasChanges: Ref<boolean>;
	// Unsaved-changes dialog.
	showUnsavedChangesDialog: Ref<boolean>;
	isSavingBeforeLeave: Readonly<Ref<boolean>>;
	confirmDiscard: () => void;
	confirmSave: () => Promise<void>;
	cancelNavigation: () => void;
	// Media picker.
	showMediaPicker: Ref<boolean>;
	onMediaPickerSelect: (result: ImageUploadResult) => void;
	// Test-email modal.
	showTestEmailModal: Ref<boolean>;
	testEmailHtml: Ref<string>;
	onSendTest: (html: string) => void;
	// The save entrypoint: setSaving → opts.save() → clear dirty. Rejects on
	// failure, for callers that act on the outcome (the unsaved-changes dialog).
	save: () => Promise<void>;
	// The same save for fire-and-forget triggers (the toolbar Save button, the
	// `s` shortcut): never rejects, and toasts a failure nothing has shown yet.
	requestSave: () => Promise<void>;
	// Bind to the EmailBuilder (`ref="builderRef"`): a hydration that replaces
	// the draft is pushed into the canvas through it.
	builderRef: Ref<EmailBuilderHandle | null>;
	// A stale-revision refusal waiting for the user's choice.
	conflict: Readonly<Ref<EmailEditorConflict | null>>;
	isResolvingConflict: Ref<boolean>;
	keepMyVersion: () => Promise<void>;
	loadLatestVersion: () => Promise<void>;
	dismissConflict: () => void;
	// Co-editing (null without `coedit`): presence, notices, live state.
	coediting: EmailEditorCoedit | null;
	// Joining the live session; show the editor once this is false.
	isConnecting: Ref<boolean>;
	// Bind to the EmailBuilder's `collab-focus` event.
	onCollabFocus: (focus: BuilderCollabFocus) => void;
	// A draft's autosave session (null without `autosave`).
	autosave: EmailEditorAutosave<unknown> | null;
}

export function useEmailEditorBridge<S>(
	opts: EmailEditorBridgeOptions<S>
): EmailEditorBridgeReturn {
	// Universal canvas state. The canvas emits every change to its blocks, so
	// counting those writes stands in for deep-watching the tree.
	const { ref: blocks, version: blocksVersion } = versionedRef<EditorBlock[]>([]);
	const subject = ref('');
	const name = ref('');
	const isSaving = ref(false);
	const ctx: EmailEditorBridgeContext = { blocks, subject, name };

	// A draft's autosave session (below) owns the draft while autosave is on;
	// the manual tracker owns it otherwise. A ref: what reads it before it
	// exists (the co-editing hold) must see it once it does.
	const draftsRef = shallowRef<EmailEditorAutosave<S> | null>(null);
	const autosaveOn = () => opts.autosave?.enabled() === true;
	const draftOwned = () => (autosaveOn() ? draftsRef.value : null);

	// Unsaved-changes guard. `onSave` closes over `save` (declared below); it is
	// only invoked later from the navigation guard, by which point it is defined.
	const {
		showDialog: showUnsavedChangesDialog,
		isSavingBeforeLeave,
		confirmDiscard,
		confirmSave,
		cancelNavigation,
		setHasChanges,
	} = useUnsavedChanges({
		onSave: () => save(),
		// A draft's session decides leaving itself: what is at risk, the prompt, its Save.
		decisions: () => draftOwned()?.autosave.leave ?? null,
	});

	// Load → dirty loop.
	// The canvas keeps its own copy of the blocks and, by design, ignores an
	// incoming array that carries the block ids it last emitted (a stale echo
	// must not clobber in-flight edits). So a hydration that replaces the draft
	// (following a collaborator's write while clean, loading the latest after a
	// conflict) goes through the builder's explicit load path; `loadState`
	// no-ops when nothing differs, so the echo of the user's own save leaves the
	// canvas, its selection and its undo stack alone.
	const builderRef = ref<EmailBuilderHandle | null>(null);
	// The loaded row's editor-content revision.
	const rowRevision = () => {
		const row = opts.source.value;
		return row && opts.revision ? opts.revision(row as NonNullable<S>) : undefined;
	};

	// Co-editing: the session owns the canvas while it is live. Until it is
	// (or once it turns out it cannot be), the classic draft below follows the row.
	const coediting = opts.coedit
		? useEmailEditorCoedit(
				opts.coedit.target,
				{
					blocks,
					name,
					subject,
					fields: opts.coedit.fields,
					blocksVersion,
					builder: () => builderRef.value,
				},
				rowRevision,
				{
					// A leave being decided holds this tab's new sends. A draft sends
					// nothing on close: what it had not saved was left through the
					// leave prompt (its Discard drops it) or the browser's warning.
					held: () => draftOwned()?.autosave.holdsSends.value === true,
					managed: () => draftOwned() !== null,
				}
			)
		: null;
	const isLive = computed(() => coediting?.status.value === 'active');
	const isConnecting = computed(() => coediting?.status.value === 'connecting');
	const classicSource = computed(() =>
		(coediting && coediting.status.value !== 'unavailable') || autosaveOn()
			? undefined
			: opts.source.value
	) as Ref<S>;

	const {
		hasChanges: classicHasChanges,
		isInitialized,
		beginSubmit,
		acknowledge,
		rebase,
		reload,
		resume,
	} = useEditorDirtyTracking({
		source: classicSource,
		revision: opts.revision,
		initialize: (source) => opts.initialize(source, ctx),
		// Text typed into the inline editor reaches the blocks only when it
		// closes. Replacing the canvas before that would let it be committed on
		// top of the newer copy and saved under the newer revision, silently
		// dropping the other write; held back, it saves against the revision it
		// started from and the other write comes up as a conflict.
		holdHydration: () => builderRef.value?.isInlineEditing === true,
		canRebase: opts.canKeepDraft,
		onHydrate: () => {
			builderRef.value?.loadState({
				blocks: blocks.value,
				name: name.value,
				subject: subject.value,
			});
		},
		watchSources: [blocks, subject, name, ...(opts.extraWatch ?? [])],
		changeSignals: new Map([[blocks, blocksVersion]]),
		active: () => !autosaveOn(),
	});

	// Live, the email has unsaved changes when the session does or this tab
	// has edits still on their way. Leaving only warns when nobody else is in
	// the editor to keep them (a draft's session decides that itself).
	const hasChanges = computed(() =>
		isLive.value && coediting
			? coediting.hasSharedChanges.value || coediting.hasUnsent.value
			: (draftOwned()?.autosave.dirty.value ?? classicHasChanges.value)
	);
	watch(
		() => !draftOwned() && hasChanges.value && (!isLive.value || coediting?.isAlone.value === true),
		(guard) => setHasChanges(guard),
		{ immediate: true }
	);
	// Answering a conflict (waiting for the row it names; live, whether the
	// session may go over it). "Keep my version" live: the revision the save names.
	const choice = useEmailEditorConflictChoice({
		source: opts.source,
		revision: opts.revision,
		canKeepDraft: opts.canKeepDraft,
		coediting,
	});
	let keepOverRevision: number | null = null;

	// The handler set the builder injects, and the media picker it opens.
	const { showMediaPicker, onMediaPickerSelect } = provideEmailEditorHandlers();

	const showTestEmailModal = ref(false);
	const testEmailHtml = ref('');
	const onSendTest = (html: string) => {
		testEmailHtml.value = html;
		showTestEmailModal.value = true;
	};

	// A stale-revision refusal: the draft stays as it is until the user picks.
	// A draft's session keeps its own.
	const manualConflict = ref<EmailEditorConflict | null>(null);
	const conflict = computed(() => draftOwned()?.conflict.value ?? manualConflict.value);

	// The save entrypoint (a draft's session saves through its own queue). A
	// surface throws from opts.save to abort (validation failure, mutation
	// error), which keeps the editor dirty and propagates. A save that lands
	// clears dirty only if nothing was edited while it ran.
	const save = async () => {
		isSaving.value = true;
		const live = isLive.value ? coediting : null;
		const submission = live ? null : beginSubmit();
		try {
			if (live) {
				await saveSession(live);
			} else if (submission) {
				const landed = await opts.save(ctx, {
					source: submission.base,
					revision: submission.revision,
				});
				acknowledge(submission, typeof landed === 'number' ? landed : undefined);
			}
		} catch (error) {
			if (error instanceof StaleDraftError) {
				manualConflict.value = { currentRevision: error.currentRevision };
			}
			throw error;
		} finally {
			isSaving.value = false;
		}
	};

	// Live: the shared session, written by the server (emailEditorSessionSave.ts).
	// A draft's session names the revision itself (`revision`) and resolves the
	// revision the write stored when known.
	const saveSession = async (
		live: EmailEditorCoedit,
		autosave = false,
		revision = keepOverRevision ?? live.meta.value?.baseRevision
	): Promise<number | void> => {
		const { stored, byOther } = await saveLiveSession(
			live,
			(coeditVersion) =>
				opts.save(ctx, {
					source: (opts.source.value as NonNullable<S> | null) ?? null,
					revision,
					coeditVersion,
					autosave,
				}),
			autosave
		);
		if (!byOther) keepOverRevision = null;
		return stored;
	};

	// A Save button handler's rejection would reach Vue's error handling and
	// swap the whole editor for the page's error boundary. The failure is shown
	// already (toast, conflict dialog) or here; the draft stays dirty either way.
	const { showOperationError } = useOperationErrorToast();
	const requestSave = async () => {
		// A draft: the session's queue, and its status shows a failure.
		const owned = draftOwned();
		if (owned) {
			await owned.autosave.flush();
			return;
		}
		try {
			await save();
		} catch (error) {
			showOperationError(error);
		}
	};

	const drafts = opts.autosave
		? useEmailEditorAutosave<S>(opts.autosave, {
				ctx,
				extraWatch: opts.extraWatch ?? [],
				blocksVersion,
				builder: () => builderRef.value,
				coediting,
				source: opts.source,
				revision: opts.revision,
				initialize: (row) => opts.initialize(row, ctx),
				canKeepDraft: opts.canKeepDraft,
				choice,
				save: (base) => opts.save(ctx, base),
				saveSession: (revision) => saveSession(coediting!, true, revision),
				tracker: { isInitialized, hasChanges: classicHasChanges, beginSubmit, resume },
			})
		: null;
	draftsRef.value = drafts;

	// "Keep my version": merge the draft onto the latest row (what the user
	// changed wins, everything else is the latest row's) and save it with that
	// row's revision. Another writer in between just brings the choice back. A
	// draft that no longer fits the latest row keeps the dialog open, now only
	// offering to load the latest.
	// Live, the shared session is what is kept: the next save names the
	// latest row's revision, so it goes over the change made elsewhere.
	const keepManual = async () => {
		const pending = manualConflict.value;
		if (!pending) return;
		await choice.resolve(pending.currentRevision, () => {
			manualConflict.value = null;
			if (!pending.mustReload && isLive.value && choice.canKeepLive()) {
				keepOverRevision = pending.currentRevision;
				return requestSave();
			}
			if (!pending.mustReload && !isLive.value && rebase()) return requestSave();
			manualConflict.value = { ...pending, mustReload: true };
		});
	};

	// "Load latest": discard the draft (live: everyone's unsaved changes) and
	// show the server's version.
	const loadManual = async () => {
		const pending = manualConflict.value;
		if (!pending) return;
		await choice.resolve(pending.currentRevision, () => {
			manualConflict.value = null;
			return isLive.value && coediting ? coediting.resetShared() : reload();
		});
	};

	const keepMyVersion = () => draftOwned()?.keepMyVersion() ?? keepManual();
	const loadLatestVersion = () => draftOwned()?.loadLatestVersion() ?? loadManual();
	const dismissConflict = () => {
		const owned = draftOwned();
		if (owned) owned.dismissConflict();
		else if (!choice.isResolving.value) manualConflict.value = null;
	};

	// The advertised `s` (Save) shortcut, for every editor surface.
	useEditorSaveShortcut(() => !isSaving.value && hasChanges.value, requestSave);

	return {
		blocks,
		subject,
		name,
		isSaving,
		hasChanges,
		showUnsavedChangesDialog,
		isSavingBeforeLeave,
		// Leaving a live session alone without saving: the shared draft goes too.
		// A draft's session drops only what this tab has not sent (its `leave`).
		confirmDiscard: () => {
			if (!draftOwned() && isLive.value) void coediting?.resetShared();
			confirmDiscard();
		},
		confirmSave,
		cancelNavigation,
		showMediaPicker,
		onMediaPickerSelect,
		showTestEmailModal,
		testEmailHtml,
		onSendTest,
		save,
		requestSave,
		builderRef,
		conflict,
		isResolvingConflict: choice.isResolving,
		keepMyVersion,
		loadLatestVersion,
		dismissConflict,
		coediting,
		isConnecting,
		onCollabFocus: (focus) => coediting?.onCollabFocus(focus),
		autosave: drafts,
	};
}
