import { expect, it } from 'vitest';
import { assertDesktopManifest, type DesktopManifest } from '../ci/desktop-manifest';
const manifest: DesktopManifest = {
	version: '1.2.3',
	platforms: Object.fromEntries(
		['linux-x86_64', 'windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'].map((platform) => [
			platform,
			{
				signature: 'signed',
				url: `https://github.com/example/repo/releases/download/v1.2.3/${platform}.zip`,
			},
		])
	),
};
it('requires both Mac architectures and every signed updater platform before publishing', () => {
	expect(() => assertDesktopManifest(manifest, 'v1.2.3', 'example/repo')).not.toThrow();
	const missing = structuredClone(manifest);
	delete missing.platforms['darwin-x86_64'];
	expect(() => assertDesktopManifest(missing, 'v1.2.3', 'example/repo')).toThrow();
	const unsigned = structuredClone(manifest);
	unsigned.platforms['windows-x86_64']!.signature = '';
	expect(() => assertDesktopManifest(unsigned, 'v1.2.3', 'example/repo')).toThrow();
	expect(() => assertDesktopManifest(manifest, 'v1.2.4', 'example/repo')).toThrow();
});

it('accepts release API URLs only when the exact release owns the asset', () => {
	const copy = structuredClone(manifest);
	const url = 'https://api.github.com/repos/example/repo/releases/assets/123';
	copy.platforms['linux-x86_64']!.url = url;
	const urls = Object.values(manifest.platforms).map((p) => p.url);
	expect(() => assertDesktopManifest(copy, 'v1.2.3', 'example/repo', [...urls, url])).not.toThrow();
	expect(() => assertDesktopManifest(copy, 'v1.2.3', 'example/repo', urls)).toThrow();
});
