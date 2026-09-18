/**
 * Release tags and `latest.json` bodies — the pure half of the desktop release
 * cache, kept beside `updates.ts` so the action stays under the file-size cap
 * and so these two decisions can be unit-tested without convex-test.
 *
 * Both are trust boundaries. `parseDesktopReleaseTag` decides which release
 * lines can carry a desktop bundle at all, and `isValidManifest` decides what
 * may enter the cache: a manifest is stored VERBATIM and later served
 * byte-for-byte to an updater running as the user, so it is checked once, here,
 * before it is ever written.
 */

/**
 * Tags on the two desktop-bearing release lines: the unified `vX.Y.Z` line and
 * the target-only `desktop-vX.Y.Z` line. `server-v*` never carries a bundle.
 */
const RELEASE_TAG_RE = /^(desktop-)?v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * Hosts a bundle URL inside a cached manifest may point at. Checked ONCE, at
 * cache time, so a manifest that would send a client somewhere else is never
 * stored — the device's signature check is the second, independent defence.
 */
const MANIFEST_URL_HOSTS = new Set([
	'github.com',
	'api.github.com',
	'objects.githubusercontent.com',
]);

/** As much of a GitHub release object as the refresh action reads. */
export interface GithubRelease {
	tag_name?: string;
	body?: string;
	draft?: boolean;
	prerelease?: boolean;
	published_at?: string;
}

/**
 * Split a release tag into the version it advertises and the line it came from,
 * or `null` when the tag belongs to neither desktop-bearing line.
 */
export function parseDesktopReleaseTag(
	tag: string
): { version: string; line: 'unified' | 'desktop' } | null {
	if (!RELEASE_TAG_RE.test(tag)) return null;
	const isDesktopLine = tag.startsWith('desktop-');
	return {
		version: tag.replace(/^desktop-/, '').replace(/^v/, ''),
		line: isDesktopLine ? 'desktop' : 'unified',
	};
}

/**
 * Validate a `latest.json` before it is cached: its version must match the tag
 * it was published under, it must carry at least one platform, and every
 * platform must have a signature and a URL on the GitHub allow-list. A manifest
 * that fails is skipped, never stored.
 */
export function isValidManifest(text: string, version: string): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return false;
	}
	if (typeof parsed !== 'object' || parsed === null) return false;
	const manifest = parsed as { version?: unknown; platforms?: unknown };
	if (typeof manifest.version !== 'string') return false;
	if (manifest.version.replace(/^v/, '') !== version) return false;

	const platforms = manifest.platforms;
	if (typeof platforms !== 'object' || platforms === null || Array.isArray(platforms)) return false;
	const entries = Object.entries(platforms as Record<string, unknown>);
	if (entries.length === 0) return false;

	return entries.every(([, value]) => {
		if (typeof value !== 'object' || value === null) return false;
		const { url, signature } = value as { url?: unknown; signature?: unknown };
		if (typeof url !== 'string' || typeof signature !== 'string' || signature.length === 0) {
			return false;
		}
		try {
			return MANIFEST_URL_HOSTS.has(new URL(url).hostname.toLowerCase());
		} catch {
			return false;
		}
	});
}
