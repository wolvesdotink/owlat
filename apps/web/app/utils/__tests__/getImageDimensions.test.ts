import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getImageDimensions } from '../getImageDimensions';

/**
 * An image the test settles by dispatching the event a browser would fire once
 * `src` is set; the helper must hear it through a listener.
 */
class ScriptedImage extends EventTarget {
	static last: ScriptedImage | null = null;
	naturalWidth = 0;
	naturalHeight = 0;
	#src = '';
	get src() {
		return this.#src;
	}
	set src(value: string) {
		this.#src = value;
		ScriptedImage.last = this;
	}
	load(width: number, height: number) {
		this.naturalWidth = width;
		this.naturalHeight = height;
		this.dispatchEvent(new Event('load'));
	}
	fail() {
		this.dispatchEvent(new Event('error'));
	}
}

const revoked: string[] = [];

beforeEach(() => {
	ScriptedImage.last = null;
	revoked.length = 0;
	vi.stubGlobal('Image', ScriptedImage);
	vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owlat.example/1');
	vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
});

// Only the URL spies are undone: `vi.unstubAllGlobals` would also strip the
// setup file's Nuxt auto-import stubs, and every case re-stubs its own globals.
afterEach(() => {
	vi.restoreAllMocks();
});

const png = () => new File(['x'], 'a.png', { type: 'image/png' });

describe('getImageDimensions', () => {
	it('resolves the natural size once the image loads and revokes its object URL', async () => {
		const dims = getImageDimensions(png());
		expect(ScriptedImage.last?.src).toBe('blob:owlat.example/1');
		ScriptedImage.last!.load(640, 480);
		await expect(dims).resolves.toEqual({ width: 640, height: 480 });
		expect(revoked).toEqual(['blob:owlat.example/1']);
	});

	it('resolves null when the image fails to decode and still revokes its object URL', async () => {
		const dims = getImageDimensions(png());
		ScriptedImage.last!.fail();
		await expect(dims).resolves.toBeNull();
		expect(revoked).toEqual(['blob:owlat.example/1']);
	});

	it('resolves null for an SVG without loading it', async () => {
		await expect(
			getImageDimensions(new File(['<svg/>'], 'a.svg', { type: 'image/svg+xml' }))
		).resolves.toBeNull();
		expect(ScriptedImage.last).toBeNull();
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});
});
