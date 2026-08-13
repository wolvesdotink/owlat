import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * The web app manifest is served verbatim from `public/` — nothing builds it and
 * nothing type-checks it, so a renamed or unexported icon only shows up as a
 * blank tile on an installed home screen. This gate reads the shipped manifest,
 * resolves every icon on disk and checks the declared `sizes` against the PNG
 * header, which is exactly what the install prompt does.
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..', '..');
const publicDir = resolve(webRoot, 'public');

interface ManifestIcon {
	src: string;
	sizes: string;
	type: string;
	purpose?: string;
}

const manifest = JSON.parse(readFileSync(resolve(publicDir, 'manifest.webmanifest'), 'utf8')) as {
	name: string;
	short_name: string;
	start_url: string;
	display: string;
	icons: ManifestIcon[];
};

/** Width/height straight out of the PNG IHDR chunk. */
function pngDimensions(file: string): { width: number; height: number } {
	const bytes = readFileSync(file);
	expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
	expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('PWA manifest', () => {
	it('declares the fields the install prompt requires', () => {
		expect(manifest.name).toBeTruthy();
		expect(manifest.short_name).toBeTruthy();
		expect(manifest.display).toBe('standalone');
		// Installing lands in the app, not on the marketing landing page.
		expect(manifest.start_url).toBe('/dashboard');
		expect(manifest.icons.length).toBeGreaterThan(0);
	});

	it.each([
		['any', 192],
		['any', 512],
		['maskable', 192],
		['maskable', 512],
	])('ships a %s icon at %ipx', (purpose, size) => {
		const icon = manifest.icons.find(
			(candidate) =>
				(candidate.purpose ?? 'any') === purpose && candidate.sizes === `${size}x${size}`
		);
		expect(icon, `no ${purpose} ${size}px icon in the manifest`).toBeDefined();
	});

	it.each(manifest.icons.map((icon) => [icon.src, icon] as const))(
		'%s resolves on disk at its declared size',
		(_src, icon) => {
			// Manifest icon srcs are resolved against the manifest URL, which is served
			// from the public root.
			expect(icon.src.startsWith('/')).toBe(true);
			const file = resolve(publicDir, icon.src.slice(1));
			expect(existsSync(file), `${icon.src} is declared but not shipped`).toBe(true);

			expect(icon.type).toBe('image/png');
			const [width, height] = icon.sizes.split('x').map(Number);
			expect(pngDimensions(file)).toEqual({ width, height });
		}
	);

	it('is linked from the document head, next to the iOS home-screen icon', () => {
		// iOS ignores the manifest icons for "Add to Home Screen"; without the
		// apple-touch-icon it screenshots the page instead.
		const nuxtConfig = readFileSync(resolve(webRoot, 'nuxt.config.ts'), 'utf8');
		expect(nuxtConfig).toContain("{ rel: 'manifest', href: '/manifest.webmanifest' }");
		expect(nuxtConfig).toContain("rel: 'apple-touch-icon'");
		expect(existsSync(resolve(publicDir, 'apple-touch-icon.png'))).toBe(true);
		expect(pngDimensions(resolve(publicDir, 'apple-touch-icon.png'))).toEqual({
			width: 180,
			height: 180,
		});
	});
});
