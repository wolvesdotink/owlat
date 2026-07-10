import {
	composeArtifactUrls,
	parseSha256Manifest,
	verifyComposeTemplate,
} from '@owlat/shared/composeVerify';

/**
 * Download the pinned compose template for `targetVersion` from GitHub Releases
 * and cryptographically verify it before returning it. Shared by BOTH update
 * routes — the session-authed in-app updater (`/api/system/update`) and the
 * control-plane self-update proxy (`/api/self-update`) — so neither can forward
 * an unverified, caller-supplied template to the updater sidecar (which would
 * be an RCE via arbitrary container images).
 *
 * The release workflow publishes `docker-compose-<v>.yml` alongside a detached
 * `docker-compose-<v>.yml.sha256` manifest. We fetch both, confirm the file's
 * SHA-256 matches the published digest, and confirm it references the expected
 * pinned web image. Any failure throws an H3 error (502 on fetch/verify
 * failure) — the verified template is only returned when fully trustworthy.
 */
export async function resolveVerifiedComposeTemplate(args: {
	targetVersion: string;
	currentVersion: string;
}): Promise<string> {
	const { targetVersion, currentVersion } = args;
	const { composeUrl, sha256Url } = composeArtifactUrls(targetVersion);

	async function fetchFromRelease(url: string, accept: string): Promise<string> {
		const resp = await fetch(url, {
			headers: {
				'User-Agent': `owlat-selfhost/${currentVersion}`,
				Accept: accept,
			},
			redirect: 'follow',
			signal: AbortSignal.timeout(30_000),
		});
		if (!resp.ok) {
			throw new Error(`GitHub returned ${resp.status}`);
		}
		return resp.text();
	}

	let composeTemplate: string;
	let expectedSha256: string;
	try {
		const [templateBody, manifest] = await Promise.all([
			fetchFromRelease(composeUrl, 'text/yaml, application/x-yaml, text/plain'),
			fetchFromRelease(sha256Url, 'text/plain'),
		]);
		composeTemplate = templateBody;
		expectedSha256 = parseSha256Manifest(manifest);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown fetch error';
		throw createError({
			statusCode: 502,
			message: `Could not download release artifacts for v${targetVersion}: ${msg}`,
		});
	}

	try {
		verifyComposeTemplate({ composeTemplate, expectedSha256, targetVersion });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Compose verification failed';
		throw createError({ statusCode: 502, message: msg });
	}

	return composeTemplate;
}
