import { arrayOf, decodeJson, type Decoder, integer, object, recordOf, string } from '../json';
export interface DesktopManifest {
	version: string;
	platforms: Record<string, { url: string; signature: string }>;
}
interface DesktopRelease {
	id: number;
	tag_name: string;
	assets: { id: number; name: string; url: string; browser_download_url: string }[];
}
export const decodeDesktopRelease: Decoder<DesktopRelease> = object({
	id: integer,
	tag_name: string,
	assets: arrayOf(object({ id: integer, name: string, url: string, browser_download_url: string })),
});
const decodeDesktopManifest: Decoder<DesktopManifest> = object({
	version: string,
	platforms: recordOf(object({ url: string, signature: string })),
});
/** The updater's `latest.json` as downloaded from the release. */
export function parseDesktopManifest(text: string, label: string): DesktopManifest {
	return decodeJson(text, decodeDesktopManifest, label);
}
// Draft releases must be addressed by the caller's numeric ID. A tag lookup
// excludes drafts and may select another release when stale drafts exist.
export function verifyDesktopRelease(
	repo: string,
	tag: string,
	releaseId: string,
	fetchRelease: (path: string) => DesktopRelease,
	fetchManifest: (path: string) => DesktopManifest
) {
	if (!/^[1-9]\d*$/.test(releaseId)) throw new Error('Invalid release ID');
	const release = fetchRelease(`repos/${repo}/releases/${releaseId}`);
	if (String(release.id) !== releaseId || release.tag_name !== tag)
		throw new Error('Desktop release identity mismatch');
	const manifests = release.assets.filter((asset) => asset.name === 'latest.json');
	if (manifests.length !== 1) throw new Error('Expected exactly one updater manifest');
	const manifest = fetchManifest(`repos/${repo}/releases/assets/${manifests[0]!.id}`);
	assertDesktopManifest(
		manifest,
		tag,
		repo,
		release.assets.flatMap((asset) => [asset.url, asset.browser_download_url])
	);
}
export function assertDesktopManifest(
	manifest: DesktopManifest,
	tag: string,
	repo: string,
	assetURLs?: string[]
) {
	const version = tag.replace(/^desktop-v|^v/, '');
	if (manifest.version !== version) throw new Error('Desktop updater version mismatch');
	for (const platform of ['linux-x86_64', 'windows-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
		const artifact = manifest.platforms?.[platform];
		if (!artifact?.signature?.trim())
			throw new Error(`Missing signed updater platform: ${platform}`);
		const url = new URL(artifact.url);
		if (assetURLs) {
			// tauri-action may use the GitHub release-asset API URL instead of the
			// browser download URL. Both must belong to this exact draft release.
			if (!assetURLs.includes(url.href))
				throw new Error(`Updater asset does not belong to release: ${platform}`);
		} else if (
			url.origin !== 'https://github.com' ||
			!url.pathname.toLowerCase().startsWith(`/${repo}/releases/download/${tag}/`.toLowerCase())
		)
			throw new Error(`Updater URL mismatch: ${platform}`);
	}
}
