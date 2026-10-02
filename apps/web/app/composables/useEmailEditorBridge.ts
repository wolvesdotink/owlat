import { computed, ref, watch, type Ref } from 'vue';
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
import { provideEmailEditorHandlers } from './emailEditorHandlers';
import type { CoeditTarget } from './useEmailCoediting';
import { useEmailEditorCoedit, type EmailEditorCoedit } from './useEmailEditorCoedit';

/**
 * Email editor bridge (module) — the app-side owner that backs the
 * `EmailBuilder` component against Convex and runs its edit loop. See
 * docs/adr/0035-email-editor-bridge-module.md and CONTEXT.md `## Email editor`.
 *
 * The three editor surfaces (Email template, Transactional email, Saved block)
 * supply only their divergent halves — a per-surface `initialize(source)` parse
 * and `save()` serialize, plus an optional `extraWatch` list for surface-specific
 * dirty-tracked refs. The bridge never branches on which surface it serves.
 *
 * With `coedit`, the email is edited live together with everyone else who
 * has it open (docs/adr/0071-email-coediting.md): the canvas follows the
 * shared session instead of the row, other people's edits arrive block by
 * block, and Save writes the session. A member who cannot co-edit falls back
 * to the classic draft below.
 */

/** How long a conflict choice waits for the live query to deliver the newer row. */
const CONFLICT_CATCH_UP_MS = 5000;

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
	conflict: Ref<EmailEditorConflict | null>;
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
		onSave: async () => {
			await save();
		},
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
				() => {
					const row = opts.source.value;
					return row && opts.revision ? opts.revision(row as NonNullable<S>) : undefined;
				}
			)
		: null;
	const isLive = computed(() => coediting?.status.value === 'active');
	const isConnecting = computed(() => coediting?.status.value === 'connecting');
	const classicSource = computed(() =>
		coediting && coediting.status.value !== 'unavailable' ? undefined : opts.source.value
	) as Ref<S>;

	const {
		hasChanges: classicHasChanges,
		beginSubmit,
		acknowledge,
		rebase,
		reload,
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
	});

	// Live, the email has unsaved changes when the session does or this tab
	// has edits still on their way. Leaving only warns when nobody else is in
	// the editor to keep them.
	const hasChanges = computed(() =>
		isLive.value && coediting
			? coediting.hasSharedChanges.value || coediting.hasUnsent.value
			: classicHasChanges.value
	);
	watch(
		() => hasChanges.value && (!isLive.value || coediting?.isAlone.value === true),
		(guard) => setHasChanges(guard),
		{ immediate: true }
	);
	// The row the session was last based on, for "keep my version".
	let rowAtSessionBase: NonNullable<S> | null = null;
	watch([() => opts.source.value, () => coediting?.meta.value], ([row, meta]) => {
		if (row && meta && opts.revision?.(row as NonNullable<S>) === meta.baseRevision) {
			rowAtSessionBase = row as NonNullable<S>;
		}
	});
	// "Keep my version" over a row that moved on: the revision the save names.
	let keepOverRevision: number | null = null;

	// The handler set the builder injects, and the media picker it opens.
	const { showMediaPicker, onMediaPickerSelect } = provideEmailEditorHandlers();

	// Test-email modal.
	const showTestEmailModal = ref(false);
	const testEmailHtml = ref('');
	const onSendTest = (html: string) => {
		testEmailHtml.value = html;
		showTestEmailModal.value = true;
	};

	// A stale-revision refusal: the draft stays as it is until the user picks.
	const conflict = ref<EmailEditorConflict | null>(null);
	const isResolvingConflict = ref(false);

	// The save entrypoint. A surface throws from opts.save to abort (validation
	// failure, mutation error), which keeps the editor dirty and propagates. A
	// save that lands clears dirty only if nothing was edited while it ran.
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
				conflict.value = { currentRevision: error.currentRevision };
			}
			throw error;
		} finally {
			isSaving.value = false;
		}
	};

	// Live: send what this tab still has, then save the shared session (the
	// server writes the session, so nobody's edit that reached it is lost).
	const saveSession = async (live: EmailEditorCoedit) => {
		await live.flushNow();
		const seen = live.seenVersion();
		await opts.save(ctx, {
			source: (opts.source.value as NonNullable<S> | null) ?? null,
			revision: keepOverRevision ?? live.meta.value?.baseRevision,
			coeditVersion: seen,
		});
		keepOverRevision = null;
		// The leave guard reads the dirty flag right after this resolves.
		if (seen !== undefined) await live.untilSaved(seen);
	};

	// A Save button handler's rejection would reach Vue's error handling and
	// swap the whole editor for the page's error boundary. The failure has
	// either been shown already (toast, conflict dialog) or is shown here; the
	// draft stays dirty either way.
	const { showOperationError } = useOperationErrorToast();
	const requestSave = async () => {
		try {
			await save();
		} catch (error) {
			showOperationError(error);
		}
	};

	// The server row a conflict names can reach this tab a moment after the
	// refusal; resolving against an older emission would hide the change the
	// user was just told about. Wait (briefly) for the live query to deliver it.
	const hasReached = (target: number) => {
		const row = opts.source.value;
		return !row || !opts.revision || opts.revision(row as NonNullable<S>) >= target;
	};
	const untilRevision = (target: number) =>
		new Promise<void>((resolve) => {
			if (hasReached(target)) {
				resolve();
				return;
			}
			const stop = watch(opts.source, () => {
				if (hasReached(target)) finish();
			});
			const timer = setTimeout(() => finish(), CONFLICT_CATCH_UP_MS);
			const finish = () => {
				clearTimeout(timer);
				stop();
				resolve();
			};
		});

	const resolveConflict = async (
		resolve: (pending: EmailEditorConflict) => Promise<void> | void
	) => {
		const pending = conflict.value;
		if (!pending || isResolvingConflict.value) return;
		isResolvingConflict.value = true;
		try {
			await untilRevision(pending.currentRevision);
			conflict.value = null;
			await resolve(pending);
		} finally {
			isResolvingConflict.value = false;
		}
	};

	// "Keep my version": merge the draft onto the latest row (what the user
	// changed wins, everything else is the latest row's) and save it with that
	// row's revision. Another writer in between just brings the choice back. A
	// draft that no longer fits the latest row keeps the dialog open, now only
	// offering to load the latest.
	// Live, the shared session is what is kept: the next save names the
	// latest row's revision, so it goes over the change made elsewhere.
	const canKeepLive = () => {
		const latest = opts.source.value as NonNullable<S> | null;
		return !rowAtSessionBase || !latest || opts.canKeepDraft?.(rowAtSessionBase, latest) !== false;
	};
	const keepMyVersion = () =>
		resolveConflict((pending) => {
			if (!pending.mustReload && isLive.value && canKeepLive()) {
				keepOverRevision = pending.currentRevision;
				return requestSave();
			}
			if (!pending.mustReload && !isLive.value && rebase()) return requestSave();
			conflict.value = { ...pending, mustReload: true };
		});

	// "Load latest": discard the draft (live: everyone's unsaved changes) and
	// show the server's version.
	const loadLatestVersion = () =>
		resolveConflict(() => (isLive.value && coediting ? coediting.resetShared() : reload()));

	const dismissConflict = () => {
		if (!isResolvingConflict.value) conflict.value = null;
	};

	// Wire the advertised `s` (Save) shortcut for every editor surface. The
	// shortcut is registered with `ignoreInputs`, so it never fires while a text
	// field is focused; the guard below additionally no-ops when nothing changed
	// or a save is already in flight.
	const { registerSaveShortcut, unregisterShortcut } = useKeyboardShortcuts();
	onMounted(() => {
		registerSaveShortcut(() => {
			if (isSaving.value || !hasChanges.value) return;
			void requestSave();
		});
	});
	onUnmounted(() => {
		unregisterShortcut('global.save');
	});

	return {
		blocks,
		subject,
		name,
		isSaving,
		hasChanges,
		showUnsavedChangesDialog,
		isSavingBeforeLeave,
		// Leaving a live session alone without saving: the shared draft goes too.
		confirmDiscard: () => {
			if (isLive.value) void coediting?.resetShared();
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
		isResolvingConflict,
		keepMyVersion,
		loadLatestVersion,
		dismissConflict,
		coediting,
		isConnecting,
		onCollabFocus: (focus) => coediting?.onCollabFocus(focus),
	};
}
