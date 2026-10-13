export interface DesktopManifest {
	version: string;
	platforms: Record<string, { url: string; signature: string }>;
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
