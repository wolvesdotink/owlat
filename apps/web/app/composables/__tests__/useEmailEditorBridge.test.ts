import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ref, nextTick } from 'vue';

// The bridge module imports value exports from @owlat/email-builder (whose entry
// pulls in .vue SFCs) and @owlat/api. The pure helpers under test touch neither,
// so stub both so the module imports cleanly without a Vue/SFC plugin.
vi.mock('@owlat/email-builder', () => ({
	provideEmailBuilderHandlers: vi.fn(),
}));
vi.mock('@owlat/api', () => ({ api: {} }));

import { createUploadImageHandler, useEditorDirtyTracking } from '../useEmailEditorBridge';

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
			createMediaAsset: vi.fn().mockResolvedValue({ _id: 'asset_1' }),
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

		expect(result).toEqual({ url: 'https://cdn.example/image.png', storageId: 'st_1' });
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

	it('throws when the registered asset has no resolvable URL', async () => {
		deps.getUrl.mockResolvedValue(null);
		const upload = createUploadImageHandler(deps);

		// The asset is registered first (so getUrl can resolve a media-backed
		// blob); a null URL afterward still surfaces as a hard error.
		await expect(upload(makeFile())).rejects.toThrow('Failed to get image URL');
		expect(deps.createMediaAsset).toHaveBeenCalledOnce();
	});
});

describe('useEditorDirtyTracking', () => {
	it('stays clean through initialize, flips dirty on a tracked edit, resets on markClean', async () => {
		const source = ref<{ name: string } | null>(null);
		const name = ref('');
		const blocks = ref<unknown[]>([]);
		const onDirtyChange = vi.fn();

		const { hasChanges, markClean, isInitialized } = useEditorDirtyTracking({
			source,
			initialize: (s) => {
				name.value = s.name;
				blocks.value = [{ id: '1' }];
			},
			watchSources: [() => name.value, () => blocks.value],
			onDirtyChange,
		});

		expect(hasChanges.value).toBe(false);
		expect(isInitialized.value).toBe(false);

		// Data loads → initialize runs, but the editor must not be marked dirty.
		source.value = { name: 'Loaded' };
		await nextTick(); // flush source watcher (initialize + change watcher no-op)
		await nextTick(); // flush the deferred isInitialized flag

		expect(name.value).toBe('Loaded');
		expect(isInitialized.value).toBe(true);
		expect(hasChanges.value).toBe(false);

		// A real edit flips dirty.
		name.value = 'Edited';
		await nextTick();
		expect(hasChanges.value).toBe(true);
		expect(onDirtyChange).toHaveBeenLastCalledWith(true);

		// A save resets it.
		markClean();
		expect(hasChanges.value).toBe(false);
		expect(onDirtyChange).toHaveBeenLastCalledWith(false);
	});

	it('treats extraWatch-style sources (e.g. attachments) as dirty-tracked', async () => {
		const source = ref<{ name: string } | null>({ name: 'X' });
		const attachments = ref<string[]>([]);

		const { hasChanges } = useEditorDirtyTracking({
			source,
			initialize: () => {},
			watchSources: [() => attachments.value],
		});

		await nextTick(); // immediate init runs synchronously; flush isInitialized
		await nextTick();
		expect(hasChanges.value).toBe(false);

		attachments.value = [...attachments.value, 'invoice.pdf'];
		await nextTick();
		expect(hasChanges.value).toBe(true);
	});
});
