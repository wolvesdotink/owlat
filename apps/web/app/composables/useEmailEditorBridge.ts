import { ref, watch, nextTick, type Ref } from 'vue';
import {
	provideEmailBuilderHandlers,
	type EditorBlock,
	type ImageUploadResult,
	type SavedBlock,
} from '@owlat/email-builder';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { getImageDimensions } from '~/utils/getImageDimensions';

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

export interface UploadImageDeps {
	/** Mint a one-shot upload URL (Convex `storage.generateUploadUrl`). */
	generateUploadUrl: () => Promise<string | null | undefined>;
	/** Resolve a stored file's public URL (Convex `storage.getUrl`). */
	getUrl: (storageId: Id<'_storage'>) => Promise<string | null>;
	/** Register the uploaded file in the media library (Convex `mediaAssets.create`). */
	createMediaAsset: (asset: {
		storageId: Id<'_storage'>;
		filename: string;
		mimeType: string;
		fileSize: number;
		width?: number;
		height?: number;
	}) => Promise<unknown>;
	/** Measure the image client-side for the media-library record. */
	getImageDimensions: (file: File) => Promise<{ width: number; height: number } | null>;
}

/**
 * Build the `uploadImage` handler the EmailBuilder injects:
 * `generateUploadUrl` → POST the file → `storage.getUrl` → measure dimensions →
 * `mediaAssets.create`. Every uploaded image is auto-registered to the media
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

		const { storageId } = await response.json();

		// Auto-save to media library FIRST: `storage.getUrl` only resolves blobs
		// backed by a `mediaAssets` row (cross-resource IDOR guard), so the asset
		// must exist before we can mint its URL.
		const dimensions = await deps.getImageDimensions(file);
		await deps.createMediaAsset({
			storageId,
			filename: file.name,
			mimeType: file.type,
			fileSize: file.size,
			width: dimensions?.width,
			height: dimensions?.height,
		});

		const url = await deps.getUrl(storageId);

		if (!url) {
			throw new Error('Failed to get image URL');
		}

		return { url, storageId };
	};
}

// ---------------------------------------------------------------------------
// load → dirty loop — also pure (only Vue reactivity), so dirty-tracking
// correctness is testable without mounting a page.
// ---------------------------------------------------------------------------

export interface UseEditorDirtyTrackingOptions<S> {
	/** The loaded row; `initialize` runs each time it becomes truthy. */
	source: Ref<S>;
	/** Per-surface parse of the loaded row into the tracked refs. */
	initialize: (source: NonNullable<S>) => void;
	/** Getters for the refs whose deep changes mark the editor dirty. */
	watchSources: (() => unknown)[];
	/** Notified whenever the dirty flag flips (bridges to `setHasChanges`). */
	onDirtyChange?: (dirty: boolean) => void;
}

export interface UseEditorDirtyTrackingReturn {
	hasChanges: Ref<boolean>;
	isInitialized: Ref<boolean>;
	markClean: () => void;
}

/**
 * The generic "set from server, then start tracking" loop: `initialize` the
 * tracked refs from the loaded row without marking dirty, then flip `hasChanges`
 * on any subsequent tracked-ref edit until `markClean()` (called after a save).
 */
export function useEditorDirtyTracking<S>(
	opts: UseEditorDirtyTrackingOptions<S>
): UseEditorDirtyTrackingReturn {
	const hasChanges = ref(false);
	const isInitialized = ref(false);

	const setDirty = (dirty: boolean) => {
		hasChanges.value = dirty;
		opts.onDirtyChange?.(dirty);
	};

	watch(
		opts.source,
		(source) => {
			if (!source) return;
			opts.initialize(source);
			setDirty(false);
			// Defer "initialized" by a tick so the writes initialize() just made
			// don't trip the change watcher below.
			void nextTick(() => {
				isInitialized.value = true;
			});
		},
		{ immediate: true }
	);

	watch(
		opts.watchSources,
		() => {
			// Only track changes after the initial data has been loaded.
			if (!isInitialized.value) return;
			setDirty(true);
		},
		{ deep: true }
	);

	return {
		hasChanges,
		isInitialized,
		markClean: () => setDirty(false),
	};
}

// ---------------------------------------------------------------------------
// The bridge — composes the pure pieces above with the unsaved-changes guard,
// the media-picker and test-email plumbing, and produces the handler set.
// ---------------------------------------------------------------------------

/** The universal canvas refs the bridge owns and a surface's closures write. */
export interface EmailEditorBridgeContext {
	blocks: Ref<EditorBlock[]>;
	subject: Ref<string>;
	name: Ref<string>;
}

export interface EmailEditorBridgeOptions<S> {
	/** The loaded row (template / email / block). */
	source: Ref<S>;
	/** Per-surface parse → sets blocks/subject/name (and page-owned refs). */
	initialize: (source: NonNullable<S>, ctx: EmailEditorBridgeContext) => void;
	/** Per-surface serialize + mutation. Throw to abort (keeps the editor dirty). */
	save: (ctx: EmailEditorBridgeContext) => Promise<void>;
	/** Surface-specific dirty-tracked refs (e.g. attachments, description). */
	extraWatch?: (() => unknown)[];
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
	// The save entrypoint: setSaving → opts.save() → clear dirty.
	save: () => Promise<void>;
}

export function useEmailEditorBridge<S>(
	opts: EmailEditorBridgeOptions<S>
): EmailEditorBridgeReturn {
	const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
		label: 'Get upload URL',
	});
	const { run: createMediaAsset } = useBackendOperation(api.mediaAssets.create, {
		label: 'Save media asset',
	});
	const { run: createEmailBlock } = useBackendOperation(api.emailBlocks.blocks.create, {
		label: 'Save block',
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
	const { hasChanges, markClean } = useEditorDirtyTracking({
		source: opts.source,
		initialize: (source) => opts.initialize(source, ctx),
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
		mediaPickerCallback?.({ url: result.url, storageId: result.storageId });
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
			generateUploadUrl: () => generateUploadUrl({}),
			getUrl: (storageId) => requireConvex().query(api.storage.getUrl, { storageId }),
			createMediaAsset: (asset) => createMediaAsset(asset),
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
			save: async (block) => {
				await createEmailBlock({
					name: block.name,
					content: JSON.stringify(block.content),
				});
			},
		},
	});

	// The save entrypoint: clears dirty only when opts.save resolves. A surface
	// throws from opts.save to abort (validation failure, mutation error), which
	// keeps the editor dirty and propagates — matching the pages' prior behaviour.
	const save = async () => {
		isSaving.value = true;
		try {
			await opts.save(ctx);
			markClean();
		} finally {
			isSaving.value = false;
		}
	};

	// Wire the advertised `s` (Save) shortcut for every editor surface. The
	// shortcut is registered with `ignoreInputs`, so it never fires while a text
	// field is focused; the guard below additionally no-ops when nothing changed
	// or a save is already in flight. The handler swallows save rejections so a
	// failed save (which keeps the editor dirty and toasts via the operation
	// module) doesn't surface as an unhandled rejection.
	const { registerSaveShortcut, unregisterShortcut } = useKeyboardShortcuts();
	onMounted(() => {
		registerSaveShortcut(() => {
			if (isSaving.value || !hasChanges.value) return;
			void save().catch(() => {});
		});
	});
	onUnmounted(() => {
		unregisterShortcut('s');
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
	};
}
