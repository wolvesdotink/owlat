import { createHash } from 'node:crypto';
import type { FunctionReference } from 'convex/server';
import { api, internal } from '@owlat/api';
import { requirePlatformAdmin } from '~~/server/utils/requireAdmin';
import { getInstanceSecret, callUpdater } from '~~/server/utils/updater';

// ConvexHttpClient.mutation's type only admits public function references, but
// internal mutations execute fine at runtime. Re-tag the visibility while
// preserving the inferred argument and return types.
function asPublicMutation<Args extends Record<string, unknown>, Ret>(
	ref: FunctionReference<'mutation', 'internal', Args, Ret>,
): FunctionReference<'mutation', 'public', Args, Ret> {
	return ref as unknown as FunctionReference<'mutation', 'public', Args, Ret>;
}

/**
 * Self-hosted in-app update entry point.
 *
 * Distinct from `/api/self-update` (which uses X-Instance-Secret auth, for
 * the hosted-cloud control plane). This route uses session auth and is
 * called by the platform-admin UI at Settings → System & Updates.
 *
 * Flow:
 *   1. Verify caller is a platform admin (via session cookie → Convex).
 *   2. Download the pinned docker-compose-<version>.yml from GitHub Releases.
 *   3. Record an "updateRun" doc via internal.systemUpdates.recordUpdateStart.
 *   4. POST to http://updater:3200/update with the downloaded compose template.
 *   5. Record result via internal.systemUpdates.recordUpdateFinish.
 *   6. Return the updater's response to the client.
 *
 * The web container will be restarted by the updater mid-flight. The UI
 * handles this by polling /api/internal/updater-health with retry.
 */
export default defineEventHandler(async (event) => {
	const client = await requirePlatformAdmin(event);

	const instanceSecret = getInstanceSecret('In-app updates not configured (INSTANCE_SECRET missing)');

	const body = await readBody<{ targetVersion?: string }>(event);
	const targetVersion = body?.targetVersion?.trim() || '';

	if (!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(targetVersion)) {
		throw createError({
			statusCode: 400,
			message: 'Invalid targetVersion (expected semver like 1.2.3)',
		});
	}

	const currentVersion = process.env['OWLAT_VERSION'] || 'dev';

	// 1. Fetch the pinned compose template + its SHA256 manifest from GitHub
	//    Releases. The release workflow publishes BOTH `docker-compose-<v>.yml`
	//    AND `docker-compose-<v>.yml.sha256`. Downloading and verifying both
	//    gives us tamper-evidence on the manifest — a hostile GitHub account
	//    or MitM cannot silently swap the compose file without also matching
	//    the published hash (which is attested separately by the release
	//    workflow via Sigstore/cosign in Phase 1.2).
	//
	// S2 (Phase 1.3): replaces the prior substring check — that only proved
	// the downloaded file *mentioned* the target version, not that it came
	// from Owlat's release pipeline.
	const composeUrl =
		`https://github.com/wolvesdotink/owlat/releases/download/v${targetVersion}/docker-compose-${targetVersion}.yml`;
	const sha256Url = `${composeUrl}.sha256`;

	async function fetchFromRelease(url: string, accept: string): Promise<string> {
		const resp = await fetch(url, {
			headers: {
				'User-Agent': `owlat-selfhost/${currentVersion}`,
				'Accept': accept,
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
		const [body, manifest] = await Promise.all([
			fetchFromRelease(composeUrl, 'text/yaml, application/x-yaml, text/plain'),
			fetchFromRelease(sha256Url, 'text/plain'),
		]);
		composeTemplate = body;
		// Manifest format produced by `sha256sum` is `<hex>  <filename>`.
		// Accept that AND a bare hex digest (defensive against format drift).
		const firstToken = manifest.trim().split(/\s+/)[0] || '';
		if (!/^[a-f0-9]{64}$/i.test(firstToken)) {
			throw new Error(
				`Invalid SHA256 manifest format (expected 64-hex digest, got "${firstToken.slice(0, 20)}…")`,
			);
		}
		expectedSha256 = firstToken.toLowerCase();
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown fetch error';
		throw createError({
			statusCode: 502,
			message: `Could not download release artifacts for v${targetVersion}: ${msg}`,
		});
	}

	// Cryptographically verify the compose file against the published hash.
	const actualSha256 = createHash('sha256').update(composeTemplate).digest('hex');
	if (actualSha256 !== expectedSha256) {
		throw createError({
			statusCode: 502,
			message: `Compose template hash mismatch — refusing to apply. Expected ${expectedSha256}, got ${actualSha256}. This may indicate a tampered release artifact; contact support before retrying.`,
		});
	}

	// Defence-in-depth: confirm the verified body references the expected web
	// image version. Cheap check that catches mismatched-manifest releases
	// (wrong sha256 published for wrong compose file). Released templates pin
	// the canonical ghcr.io/wolvesdotink org (root docker-compose.yml +
	// gen-release-compose.sh).
	if (!composeTemplate.includes(`ghcr.io/wolvesdotink/web:${targetVersion}`)) {
		throw createError({
			statusCode: 502,
			message: `Verified compose template does not reference v${targetVersion}`,
		});
	}

	// 2. Look up the current user for audit trail.
	const identity = await client
		.query(api.platformAdmin.platformAdmin.isPlatformAdmin, {})
		.catch(() => null);
	// isPlatformAdmin returned true already (from requirePlatformAdmin), so use
	// a dedicated identity query if available — for now, we don't need the
	// auth user id; use a generic tag.
	void identity;

	// 3. Record the update start.
	const runId = await client.mutation(
		asPublicMutation(internal.systemUpdates.recordUpdateStart),
		{
			versionFrom: currentVersion,
			versionTo: targetVersion,
			initiatedBy: 'platform-admin', // TODO: surface actual user id
		},
	);

	// 4. Dispatch to the updater sidecar.
	let updaterResult: { success?: boolean; error?: string; steps?: { step: string; stdout: string; stderr: string }[] } = {};
	let updaterOk = false;

	try {
		const updaterResp = await callUpdater('/update', instanceSecret, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ composeTemplate }),
			// Generous timeout — pull + recreate + convex-deploy can take minutes
			signal: AbortSignal.timeout(10 * 60 * 1000),
		});

		updaterResult = await updaterResp.json() as typeof updaterResult;
		updaterOk = updaterResp.ok;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown updater error';
		updaterResult = { success: false, error: msg };
		updaterOk = false;
	}

	// 5. Record the result. (Uses `client` which we created in requirePlatformAdmin;
	// its auth JWT may have expired mid-update if the web container restarted,
	// but internal mutations in Convex don't require client-side auth — this
	// call is purely best-effort audit.)
	try {
		await client.mutation(asPublicMutation(internal.systemUpdates.recordUpdateFinish), {
			runId,
			status: updaterOk ? 'success' : 'failed',
			steps: updaterResult.steps,
			error: updaterResult.error,
		});
	} catch {
		// Convex may have dropped auth during the update. Ignore — the UI will
		// reconcile on the next page load by reading the history.
	}

	if (!updaterOk) {
		throw createError({
			statusCode: 502,
			message: updaterResult.error || 'Update failed',
			data: updaterResult,
		});
	}

	return {
		success: true,
		runId,
		versionFrom: currentVersion,
		versionTo: targetVersion,
		steps: updaterResult.steps,
	};
});
