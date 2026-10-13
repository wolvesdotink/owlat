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

it('validates a draft by numeric ID and downloads only its manifest asset', async () => {
	const { verifyDesktopRelease } = await import('../ci/desktop-manifest');
	const calls: string[] = [];
	const draft = {
		id: 42,
		tag_name: 'v1.2.3',
		draft: true,
		assets: [
			{
				id: 100,
				name: 'latest.json',
				url: 'https://api.github.com/repos/example/repo/releases/assets/100',
				browser_download_url:
					'https://github.com/example/repo/releases/download/untagged-draft/latest.json',
			},
			...Object.values(manifest.platforms).map((platform, i) => ({
				id: i + 101,
				name: `platform-${i}.zip`,
				url: `https://api.github.com/repos/example/repo/releases/assets/${i + 101}`,
				browser_download_url: platform.url.replace('v1.2.3', 'untagged-draft'),
			})),
		],
	};
	const draftManifest = structuredClone(manifest);
	for (const [i, platform] of Object.values(draftManifest.platforms).entries())
		platform.url = draft.assets[i + 1]!.url;
	const releaseFetcher = (path: string) => {
		calls.push(path);
		return draft;
	};
	const assetFetcher = (path: string) => {
		calls.push(path);
		return draftManifest;
	};
	expect(() =>
		verifyDesktopRelease('example/repo', 'v1.2.3', '42', releaseFetcher, assetFetcher)
	).not.toThrow();
	expect(calls).toEqual([
		'repos/example/repo/releases/42',
		'repos/example/repo/releases/assets/100',
	]);
	expect(() =>
		verifyDesktopRelease('example/repo', 'v1.2.3', '43', releaseFetcher, assetFetcher)
	).toThrow('identity');
	expect(() =>
		verifyDesktopRelease('example/repo', 'v1.2.4', '42', releaseFetcher, assetFetcher)
	).toThrow('identity');
	draft.assets.shift();
	expect(() =>
		verifyDesktopRelease('example/repo', 'v1.2.3', '42', releaseFetcher, assetFetcher)
	).toThrow('exactly one');
});
