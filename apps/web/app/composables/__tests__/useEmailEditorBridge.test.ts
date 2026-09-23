import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The bridge module imports value exports from @owlat/email-builder (whose entry
// pulls in .vue SFCs) and @owlat/api. Stub both so the module imports cleanly
// without a Vue/SFC plugin; the api stub carries only the references the bridge
// hands to (stubbed) useBackendOperation.
vi.mock('@owlat/email-builder', () => ({
	provideEmailBuilderHandlers: vi.fn(),
}));
vi.mock('@owlat/api', () => ({
	api: {
		storage: { generateUploadUrl: 'storage.generateUploadUrl' },
		mediaAssets: { create: 'mediaAssets.create' },
		emailBlocks: { blocks: { create: 'emailBlocks.blocks.create' } },
	},
}));

import { ref, nextTick } from 'vue';
import {
	createSavedBlockSaveHandler,
	createUploadImageHandler,
	useEmailEditorBridge,
} from '../useEmailEditorBridge';
import { SurfacedOperationError } from '~/lib/operationError';

describe('createUploadImageHandler', () => {
	let deps: {
		generateUploadUrl: ReturnType<typeof vi.fn>;
		getUrl: ReturnType<typeof vi.fn>;
		createMediaAsset: ReturnType<typeof vi.fn>;
		getImageDimensions: ReturnType<typeof vi.fn>;
	};
	let fetchMock: ReturnType<typeof vi.fn>;

	const makeFile = () => new File(['data'], 'photo.png', { type: 'image/png' });

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ storageId: 'st_1' }) });
		vi.stubGlobal('fetch', fetchMock);
		deps = {
			generateUploadUrl: vi.fn().mockResolvedValue('https://upload.example/url'),
			getUrl: vi.fn().mockResolvedValue('https://cdn.example/image.png'),
			createMediaAsset: vi.fn().mockResolvedValue('asset_1'),
			getImageDimensions: vi.fn().mockResolvedValue({ width: 800, height: 600 }),
		};
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('runs the four steps in order and returns the resulting url + storageId', async () => {
		const upload = createUploadImageHandler(deps);
		const file = makeFile();

		const result = await upload(file);

		expect(result).toEqual({
			url: 'https://cdn.example/image.png',
			storageId: 'st_1',
			mediaAssetId: 'asset_1',
		});
		expect(deps.generateUploadUrl).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith('https://upload.example/url', {
			method: 'POST',
			headers: { 'Content-Type': 'image/png' },
			body: file,
		});
		expect(deps.getUrl).toHaveBeenCalledWith('st_1');

		// generateUploadUrl → POST → createMediaAsset → getUrl, in that order.
		// The media asset must be registered BEFORE minting the URL: `storage.getUrl`
		// only resolves blobs backed by a mediaAssets row (cross-resource IDOR guard).
		const order = (fn: ReturnType<typeof vi.fn>) => fn.mock.invocationCallOrder[0];
		expect(order(deps.generateUploadUrl)).toBeLessThan(order(fetchMock));
		expect(order(fetchMock)).toBeLessThan(order(deps.createMediaAsset));
		expect(order(deps.createMediaAsset)).toBeLessThan(order(deps.getUrl));
	});

	it('auto-registers the upload to the media library with measured dimensions', async () => {
		const upload = createUploadImageHandler(deps);
		const file = makeFile();

		await upload(file);

		expect(deps.getImageDimensions).toHaveBeenCalledOnce();
		expect(deps.createMediaAsset).toHaveBeenCalledWith({
			storageId: 'st_1',
			filename: 'photo.png',
			mimeType: 'image/png',
			fileSize: file.size,
			width: 800,
			height: 600,
		});
	});

	it('throws when no upload URL is returned and never POSTs', async () => {
		deps.generateUploadUrl.mockResolvedValue(null);
		const upload = createUploadImageHandler(deps);

		await expect(upload(makeFile())).rejects.toThrow('Failed to get upload URL');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('throws when the upload POST is not ok and never resolves a URL', async () => {
		fetchMock.mockResolvedValue({ ok: false });
		const upload = createUploadImageHandler(deps);

		await expect(upload(makeFile())).rejects.toThrow('Failed to upload image');
		expect(deps.getUrl).not.toHaveBeenCalled();
	});

	it('rejects an upload response without a durable storage ID', async () => {
		fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
		const upload = createUploadImageHandler(deps);

		await expect(upload(makeFile())).rejects.toThrow('Image upload did not return a storage ID');
		expect(deps.createMediaAsset).not.toHaveBeenCalled();
		expect(deps.getUrl).not.toHaveBeenCalled();
	});

	it('throws when the registered asset has no resolvable URL', async () => {
		deps.getUrl.mockResolvedValue(null);
		const upload = createUploadImageHandler(deps);

		// The asset is registered first (so getUrl can resolve a media-backed
		// blob); a null URL afterward still surfaces as a hard error.
		await expect(upload(makeFile())).rejects.toThrow('Failed to get image URL');
		expect(deps.createMediaAsset).toHaveBeenCalledOnce();
	});
});

describe('createSavedBlockSaveHandler', () => {
	const block = { id: 'b1', type: 'text', content: { html: 'Hi' } } as never;

	it('resolves once the block is stored', async () => {
		const createEmailBlock = vi.fn().mockResolvedValue({ ok: true, result: 'block_1' });
		const save = createSavedBlockSaveHandler(createEmailBlock);

		await expect(save({ name: 'Header', content: [block] })).resolves.toBeUndefined();
		expect(createEmailBlock).toHaveBeenCalledWith({
			name: 'Header',
			content: JSON.stringify([block]),
		});
	});

	it('rejects on a failed operation result so the save dialog stays open', async () => {
		// useBackendOperation never throws: it toasts and resolves { ok: false }.
		// Resolving here told the builder the block was saved.
		const createEmailBlock = vi.fn().mockResolvedValue({ ok: false });
		const save = createSavedBlockSaveHandler(createEmailBlock);

		await expect(save({ name: 'Header', content: [block] })).rejects.toBeInstanceOf(
			SurfacedOperationError
		);
	});
});

describe('useEmailEditorBridge save', () => {
	interface TemplateRow {
		_id: string;
		name: string;
		subject: string;
		contentRevision?: number;
	}

	beforeEach(() => {
		vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
		vi.stubGlobal('useBackendOperation', () => ({ run: vi.fn() }));
		vi.stubGlobal('useUnsavedChanges', () => ({
			showDialog: ref(false),
			confirmDiscard: vi.fn(),
			confirmSave: vi.fn(),
			cancelNavigation: vi.fn(),
			setHasChanges: vi.fn(),
		}));
		vi.stubGlobal('useKeyboardShortcuts', () => ({
			registerSaveShortcut: vi.fn(),
			unregisterShortcut: vi.fn(),
		}));
		// No component instance here; the shortcut wiring is not under test.
		vi.stubGlobal('onMounted', vi.fn());
		vi.stubGlobal('onUnmounted', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function settle() {
		await nextTick();
		await nextTick();
	}

	function setup() {
		const source = ref<TemplateRow | null>({
			_id: 't1',
			name: 'Welcome',
			subject: 'Hello',
			contentRevision: 2,
		});
		let finishSave: () => void = () => {};
		const save = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finishSave = resolve;
				})
		);
		const bridge = useEmailEditorBridge({
			source,
			revision: (row) => row.contentRevision ?? 0,
			initialize: (row, ctx) => {
				ctx.name.value = row.name;
				ctx.subject.value = row.subject;
			},
			save,
		});
		return { source, save, bridge, finish: () => finishSave() };
	}

	it('hands the save the loaded row and its revision, then clears dirty on the echo', async () => {
		const { source, save, bridge, finish } = setup();
		await settle();
		bridge.subject.value = 'Hello there';
		await nextTick();
		expect(bridge.hasChanges.value).toBe(true);

		const pending = bridge.save();
		expect(save).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ source: expect.objectContaining({ _id: 't1' }), revision: 2 })
		);

		source.value = { _id: 't1', name: 'Welcome', subject: 'Hello there', contentRevision: 3 };
		await settle();
		finish();
		await pending;

		expect(bridge.hasChanges.value).toBe(false);
		expect(bridge.subject.value).toBe('Hello there');
	});

	it('keeps the editor dirty for an edit made while the save was in flight', async () => {
		const { source, save, bridge, finish } = setup();
		await settle();
		bridge.subject.value = 'Hello there';
		await nextTick();

		const pending = bridge.save();
		bridge.subject.value = 'Hello there, friend';
		await nextTick();
		source.value = { _id: 't1', name: 'Welcome', subject: 'Hello there', contentRevision: 3 };
		await settle();
		finish();
		await pending;

		expect(bridge.hasChanges.value).toBe(true);
		expect(bridge.subject.value).toBe('Hello there, friend');

		// The follow-up save is built on the write that just landed.
		void bridge.save();
		expect(save).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ revision: 3 })
		);
		finish();
	});

	it('stays dirty when the surface save throws', async () => {
		const source = ref<TemplateRow | null>({ _id: 't1', name: 'Welcome', subject: 'Hello' });
		const bridge = useEmailEditorBridge({
			source,
			initialize: (row, ctx) => {
				ctx.subject.value = row.subject;
			},
			save: () => Promise.reject(new Error('Save failed')),
		});
		await settle();
		bridge.subject.value = 'Edited';
		await nextTick();

		await expect(bridge.save()).rejects.toThrow('Save failed');
		expect(bridge.hasChanges.value).toBe(true);
		expect(bridge.isSaving.value).toBe(false);
	});
});
