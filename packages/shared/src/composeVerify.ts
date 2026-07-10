import { createHash } from 'node:crypto';

/**
 * Pure verification helpers for the self-hosted update flow.
 *
 * Both update entry points — the session-authed in-app updater
 * (`/api/system/update`) and the control-plane self-update proxy
 * (`/api/self-update`) — must forward ONLY a compose template that has been
 * cryptographically attested by Owlat's release pipeline. A caller-supplied
 * compose template is never trusted: an attacker who forwarded an arbitrary
 * template could point the updater at arbitrary container images (RCE on the
 * host). These helpers centralise that verification so both routes stay in
 * lock-step.
 *
 * The functions here are intentionally I/O-free (no fetch, no HTTP-framework
 * error shapes) so they can be exhaustively unit-tested. The web server owns
 * the download + `createError` wrapping around them.
 */

/** Canonical GitHub Releases download prefix for the public `owlat` repo. */
export const RELEASE_DOWNLOAD_BASE = 'https://github.com/wolvesdotink/owlat/releases/download';

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

/**
 * Extract the expected digest from a `sha256sum`-style manifest. That format is
 * `<hex>  <filename>`; a bare hex digest is also accepted (defensive against
 * format drift). Returns the lower-cased 64-hex digest, or throws if the
 * manifest does not begin with one.
 */
export function parseSha256Manifest(manifest: string): string {
	const firstToken = manifest.trim().split(/\s+/)[0] || '';
	if (!/^[a-f0-9]{64}$/i.test(firstToken)) {
		throw new Error(
			`Invalid SHA256 manifest format (expected 64-hex digest, got "${firstToken.slice(0, 20)}…")`
		);
	}
	return firstToken.toLowerCase();
}

/**
 * Verify a downloaded compose template against its published digest and the
 * expected pinned web image. Throws with an operator-facing message on any
 * mismatch; returns normally when the template is trustworthy.
 *
 *   1. SHA-256 of the template must equal the published manifest digest —
 *      tamper-evidence against a hostile release host or MitM.
 *   2. The verified template must reference `ghcr.io/wolvesdotink/web:<v>` —
 *      defence-in-depth against a mismatched-manifest release (right hash for
 *      the wrong compose file).
 */
export function verifyComposeTemplate(args: {
	composeTemplate: string;
	expectedSha256: string;
	targetVersion: string;
}): void {
	const { composeTemplate, expectedSha256, targetVersion } = args;

	const actualSha256 = createHash('sha256').update(composeTemplate).digest('hex');
	if (actualSha256 !== expectedSha256.toLowerCase()) {
		throw new Error(
			`Compose template hash mismatch — refusing to apply. Expected ${expectedSha256}, got ${actualSha256}. This may indicate a tampered release artifact; contact support before retrying.`
		);
	}

	if (!composeTemplate.includes(`ghcr.io/wolvesdotink/web:${targetVersion}`)) {
		throw new Error(`Verified compose template does not reference v${targetVersion}`);
	}
}
