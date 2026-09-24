import { ref, watch, type Ref } from 'vue';
import {
	provideEmailBuilderHandlers,
	type EditorBlock,
	type HistoryState,
	type ImageUploadResult,
	type SavedBlock,
} from '@owlat/email-builder';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { getImageDimensions } from '~/utils/getImageDimensions';
import { SurfacedOperationError } from '~/lib/operationError';
import { useEditorDirtyTracking } from './useEditorDirtyTracking';
import { StaleDraftError } from './useEditorSaveOperation';
import { useOperationErrorToast } from './useOperationErrorToast';
import type { BackendOperationResult } from './useBackendOperation';
import {
	registerUploadedMediaReference,
	type MediaAssetReferenceDeps,
} from '~/utils/mediaAssetReference';

/**
 * Email editor bridge (module) — the app-side owner that backs the
 * `EmailBuilder` component against Convex and runs its edit loop. See
 * docs/adr/0035-email-editor-bridge-module.md and CONTEXT.md `## Email editor`.
 *
 * The three editor surfaces (Email template, Transactional email, Saved block)
 * supply only their divergent halves — a per-surface `initialize(source)` parse
 * and `save()` serialize, plus an optional `extraWatch` list for surface-specific
 * dirty-tracked refs. The bridge never branches on which surface it serves.
 */

// ---------------------------------------------------------------------------
// uploadImage pipeline — a pure function of its injected mutations, so the four
// steps, the three error modes, and the media-library side effect are testable
// without mounting a page.
// ---------------------------------------------------------------------------

export interface UploadImageDeps extends MediaAssetReferenceDeps {
	/** Mint a one-shot upload URL (Convex `storage.generateUploadUrl`). */
	generateUploadUrl: () => Promise<string | null | undefined>;
	/** Measure the image client-side for the media-library record. */
	getImageDimensions: (file: File) => Promise<{ width: number; height: number } | null>;
}

/**
 * Build the `uploadImage` handler the EmailBuilder injects:
 * `generateUploadUrl` → POST the file → measure dimensions → `mediaAssets.create`
 * → `storage.getUrl`. Every uploaded image is auto-registered to the media
 * library (the easy-to-miss side effect).
 */
export function createUploadImageHandler(
	deps: UploadImageDeps
): (file: File) => Promise<ImageUploadResult> {
	return async (file: File): Promise<ImageUploadResult> => {
		const uploadUrl = await deps.generateUploadUrl();
		if (!uploadUrl) {
			throw new Error('Failed to get upload URL');
		}

		const response = await fetch(uploadUrl, {
			method: 'POST',
			headers: { 'Content-Type': file.type },
			body: file,
		});

		if (!response.ok) {
			throw new Error('Failed to upload image');
		}

		const uploadResult = (await response.json()) as { storageId?: unknown };
		if (typeof uploadResult.storageId !== 'string' || uploadResult.storageId.length === 0) {
			throw new Error('Image upload did not return a storage ID');
		}
		const storageId = uploadResult.storageId as Id<'_storage'>;

		// Auto-save to media library FIRST: `storage.getUrl` only resolves blobs
		// backed by a `mediaAssets` row (cross-resource IDOR guard), so the asset
		// must exist before we can mint its URL.
		const dimensions = await deps.getImageDimensions(file);
		const registered = await registerUploadedMediaReference(deps, {
			storageId,
			filename: file.name,
			mimeType: file.type,
			fileSize: file.size,
			width: dimensions?.width,
			height: dimensions?.height,
		});
		if (!registered.ok && registered.reason === 'media-registration-failed') {
			throw new Error('Image upload did not create a media asset');
		}
		if (!registered.ok) {
			throw new Error('Failed to get image URL');
		}

		return registered.reference;
	};
}

/**
 * Build the `savedBlocks.save` handler from the `emailBlocks.blocks.create`
 * operation. The operation resolves `{ ok: false }` on failure (it never
 * throws), but the builder's contract is promise-shaped: it keeps its save
 * dialog open, name intact, only when the handler rejects. So a failed result
 * must become a rejection — marked as already surfaced, because the operation
 * module has toasted it.
 */
export function createSavedBlockSaveHandler(
	createEmailBlock: (args: {
		name: string;
		content: string;
	}) => Promise<BackendOperationResult<unknown>>
): (block: { name: string; content: EditorBlock[] }) => Promise<void> {
	return async (block) => {
		const created = await createEmailBlock({
			name: block.name,
			content: JSON.stringify(block.content),
		});
		if (!created.ok) throw new SurfacedOperationError('Saving the block failed');
	};
}

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
	/** Surface-specific dirty-tracked refs (e.g. attachments, description). */
	extraWatch?: (() => unknown)[];
	/** The row's editor-content revision; enables the stale-draft check. */
	revision?: (source: NonNullable<S>) => number;
}

/** What the bridge uses of the mounted EmailBuilder (its exposed API). */
export interface EmailBuilderHandle {
	/** The explicit load path for a hydrated state. */
	loadState: (state: HistoryState) => void;
	/** Text is being typed that the blocks do not hold until the editor closes. */
	readonly isInlineEditing?: boolean;
}

/** A save the backend refused because the email moved on after the draft loaded. */
export interface EmailEditorConflict {
	/** The revision the server was at when it refused the save. */
	currentRevision: number;
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
}

export function useEmailEditorBridge<S>(
	opts: EmailEditorBridgeOptions<S>
): EmailEditorBridgeReturn {
	const { t } = useI18n();

	const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
		label: () => t('shared.useEmailEditorBridge.getUploadUrlOperation'),
	});
	const { run: createMediaAsset } = useBackendOperation(api.mediaAssets.create, {
		label: () => t('shared.useEmailEditorBridge.saveMediaAssetOperation'),
	});
	const { run: createEmailBlock } = useBackendOperation(api.emailBlocks.blocks.create, {
		label: () => t('shared.useEmailEditorBridge.saveBlockOperation'),
	});

	// Universal canvas state.
	const blocks = ref<EditorBlock[]>([]);
	const subject = ref('');
	const name = ref('');
	const isSaving = ref(false);
	const ctx: EmailEditorBridgeContext = { blocks, subject, name };

	// Unsaved-changes guard. `onSave` closes over `save` (declared below); it is
	// only invoked later from the navigation guard, by which point it is defined.
	const {
		showDialog: showUnsavedChangesDialog,
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
	const { hasChanges, beginSubmit, acknowledge, rebase, reload } = useEditorDirtyTracking({
		source: opts.source,
		revision: opts.revision,
		initialize: (source) => opts.initialize(source, ctx),
		// Text typed into the inline editor reaches the blocks only when it
		// closes. Replacing the canvas before that would let it be committed on
		// top of the newer copy and saved under the newer revision, silently
		// dropping the other write; held back, it saves against the revision it
		// started from and the other write comes up as a conflict.
		holdHydration: () => builderRef.value?.isInlineEditing === true,
		onHydrate: () => {
			builderRef.value?.loadState({
				blocks: blocks.value,
				name: name.value,
				subject: subject.value,
			});
		},
		watchSources: [
			() => blocks.value,
			() => subject.value,
			() => name.value,
			...(opts.extraWatch ?? []),
		],
		onDirtyChange: setHasChanges,
	});

	// Media-picker plumbing.
	const showMediaPicker = ref(false);
	let mediaPickerCallback: ((result: ImageUploadResult) => void) | null = null;
	const onMediaPickerSelect = (result: ImageUploadResult) => {
		mediaPickerCallback?.(result);
		mediaPickerCallback = null;
		showMediaPicker.value = false;
	};

	// Test-email modal.
	const showTestEmailModal = ref(false);
	const testEmailHtml = ref('');
	const onSendTest = (html: string) => {
		testEmailHtml.value = html;
		showTestEmailModal.value = true;
	};

	// Produce the EmailBuilderHandlers the builder injects. Zero config — this is
	// the verbatim part that was copied across the three pages.
	provideEmailBuilderHandlers({
		uploadImage: createUploadImageHandler({
			generateUploadUrl: async () => {
				const minted = await generateUploadUrl({});
				return minted.ok ? minted.result : null;
			},
			getUrl: (storageId) => requireConvex().query(api.storage.getUrl, { storageId }),
			createMediaAsset: async (asset) => {
				const created = await createMediaAsset(asset);
				return created.ok ? created.result : undefined;
			},
			getImageDimensions,
		}),
		pickFromMediaLibrary: (onSelect) => {
			mediaPickerCallback = onSelect;
			showMediaPicker.value = true;
		},
		savedBlocks: {
			fetch: async (params) => {
				const result = await requireConvex().query(api.emailBlocks.blocks.list, {
					search: params?.search,
				});
				return (result ?? []) as SavedBlock[];
			},
			save: createSavedBlockSaveHandler(createEmailBlock),
		},
	});

	// A stale-revision refusal: the draft stays as it is until the user picks.
	const conflict = ref<EmailEditorConflict | null>(null);
	const isResolvingConflict = ref(false);

	// The save entrypoint. A surface throws from opts.save to abort (validation
	// failure, mutation error), which keeps the editor dirty and propagates. A
	// save that lands clears dirty only if nothing was edited while it ran.
	const save = async () => {
		isSaving.value = true;
		const submission = beginSubmit();
		try {
			const landed = await opts.save(ctx, {
				source: submission.base,
				revision: submission.revision,
			});
			acknowledge(submission, typeof landed === 'number' ? landed : undefined);
		} catch (error) {
			if (error instanceof StaleDraftError) {
				conflict.value = { currentRevision: error.currentRevision };
			}
			throw error;
		} finally {
			isSaving.value = false;
		}
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

	const resolveConflict = async (resolve: () => Promise<void> | void) => {
		const pending = conflict.value;
		if (!pending || isResolvingConflict.value) return;
		isResolvingConflict.value = true;
		try {
			await untilRevision(pending.currentRevision);
			conflict.value = null;
			await resolve();
		} finally {
			isResolvingConflict.value = false;
		}
	};

	// "Keep my version": build the same draft on the latest row (its
	// translations, its revision) and save again. Another writer in between
	// just brings the choice back.
	const keepMyVersion = () =>
		resolveConflict(() => {
			rebase();
			return requestSave();
		});

	// "Load latest": discard the draft and show the server's version.
	const loadLatestVersion = () => resolveConflict(reload);

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
		confirmDiscard,
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
	};
}
