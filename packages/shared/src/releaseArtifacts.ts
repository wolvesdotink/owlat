/**
 * Where a release lives and what counts as a version — the I/O-free, Node-free
 * half of the release plumbing.
 *
 * It is a module of its own rather than part of `composeVerify.ts` because the
 * Convex backend needs these three answers (the server update check, the
 * desktop release cache, the desktop update resolver) and Convex functions run
 * in a V8 isolate with no `node:` builtins: importing the verifier, which hashes
 * with `node:crypto`, would drag a Node builtin into the isolate and fail the
 * runtime-boundary check. Everything here is string work.
 */

/**
 * The public GitHub repository, `<owner>/<repo>`. Every release URL in the
 * product — the compose artifacts below, the server's update check and the
 * desktop release cache — is built from this one constant, so a fork or a
 * rename is a single edit.
 */
export const GITHUB_REPO_SLUG = 'wolvesdotink/owlat';

/** Canonical GitHub Releases download prefix for the public `owlat` repo. */
export const RELEASE_DOWNLOAD_BASE = `https://github.com/${GITHUB_REPO_SLUG}/releases/download`;

/** Semver with an optional pre-release suffix, e.g. `1.2.3` or `1.2.3-rc.1`. */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/;

/**
 * True when `version` is a well-formed target version (semver, optional
 * pre-release). Rejects anything that could smuggle path segments or shell
 * metacharacters into the release URL.
 */
export function isValidTargetVersion(version: string): boolean {
	return SEMVER_RE.test(version);
}

/**
 * The release-artifact URLs for a target version: the pinned compose file and
 * its detached SHA-256 manifest (published side-by-side by the release
 * workflow).
 */
export function composeArtifactUrls(targetVersion: string): {
	composeUrl: string;
	sha256Url: string;
} {
	const composeUrl = `${RELEASE_DOWNLOAD_BASE}/v${targetVersion}/docker-compose-${targetVersion}.yml`;
	return { composeUrl, sha256Url: `${composeUrl}.sha256` };
}
