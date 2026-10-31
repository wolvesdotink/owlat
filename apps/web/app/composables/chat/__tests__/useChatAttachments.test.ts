import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

/**
 * An image the test settles by dispatching the event a browser would fire once
 * `src` is set; the dimension probe must hear it through a listener. Assigning
 * `src` resolves `srcAssigned`, so the test knows the probe is waiting.
 */
class ScriptedImage extends EventTarget {
	static last: ScriptedImage | null = null;
	static srcAssigned: Promise<ScriptedImage>;
	static #markAssigned: (img: ScriptedImage) => void = () => {};
	static reset() {
		ScriptedImage.last = null;
		ScriptedImage.srcAssigned = new Promise((resolve) => {
			ScriptedImage.#markAssigned = resolve;
		});
	}
	naturalWidth = 0;
	naturalHeight = 0;
	#src = '';
	get src() {
		return this.#src;
	}
	set src(value: string) {
		this.#src = value;
		ScriptedImage.last = this;
		ScriptedImage.#markAssigned(this);
	}
}

const registered: Array<Record<string, unknown>> = [];
const revoked: string[] = [];

beforeEach(() => {
	ScriptedImage.reset();
	registered.length = 0;
	revoked.length = 0;
	vi.stubGlobal('Image', ScriptedImage);
	vi.stubGlobal('useI18n', () => ({ t: (key: string) => key }));
	vi.stubGlobal('useBackendOperation', () => ({
		run: async (args: Record<string, unknown>) => {
			if ('storageId' in args) registered.push(args);
			return { ok: true, result: 'storageId' in args ? 'asset_1' : 'https://upload.example' };
		},
		isLoading: ref(false),
	}));
	vi.stubGlobal('uploadFileToStorage', async () => ({ ok: true, storageId: 'st_1' }));
	vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owlat.example/1');
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
});

// Only the URL spies are undone: `vi.unstubAllGlobals` would also strip the
// setup file's Nuxt auto-import stubs, and every case re-stubs its own globals.
afterEach(() => {
	vi.restoreAllMocks();
});

async function loadUploader() {
	vi.resetModules();
	const { useChatAttachments } = await import('../useChatAttachments');
	return useChatAttachments();
}

const png = () => new File(['x'], 'a.png', { type: 'image/png' });

describe('useChatAttachments image probe', () => {
	it('registers the natural size of an image that loads and revokes its object URL', async () => {
		const { uploadFile } = await loadUploader();
		const upload = uploadFile(png());
		const img = await ScriptedImage.srcAssigned;
		img.naturalWidth = 320;
		img.naturalHeight = 200;
		img.dispatchEvent(new Event('load'));

		await expect(upload).resolves.toBe('asset_1');
		expect(registered).toEqual([
			expect.objectContaining({ storageId: 'st_1', width: 320, height: 200 }),
		]);
		expect(revoked).toEqual(['blob:owlat.example/1']);
	});

	it('registers an image that fails to decode without dimensions and revokes its object URL', async () => {
		const { uploadFile } = await loadUploader();
		const upload = uploadFile(png());
		(await ScriptedImage.srcAssigned).dispatchEvent(new Event('error'));

		await expect(upload).resolves.toBe('asset_1');
		expect(registered).toHaveLength(1);
		expect(registered[0]).toMatchObject({ width: undefined, height: undefined });
		expect(revoked).toEqual(['blob:owlat.example/1']);
	});

	it('does not probe a file that is not an image', async () => {
		const { uploadFile } = await loadUploader();
		await expect(uploadFile(new File(['x'], 'a.txt', { type: 'text/plain' }))).resolves.toBe(
			'asset_1'
		);
		expect(ScriptedImage.last).toBeNull();
		expect(registered).toEqual([expect.objectContaining({ width: undefined, height: undefined })]);
	});
});
