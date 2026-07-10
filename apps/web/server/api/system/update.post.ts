import type { FunctionReference } from 'convex/server';
import { api, internal } from '@owlat/api';
import { isValidTargetVersion } from '@owlat/shared/composeVerify';
import { requirePlatformAdmin } from '~~/server/utils/requireAdmin';
import { resolveVerifiedComposeTemplate } from '~~/server/utils/composeUpdate';
import { getInstanceSecret, callUpdater } from '~~/server/utils/updater';

// ConvexHttpClient.mutation's type only admits public function references, but
// internal mutations execute fine at runtime. Re-tag the visibility while
// preserving the inferred argument and return types.
function asPublicMutation<Args extends Record<string, unknown>, Ret>(
	ref: FunctionReference<'mutation', 'internal', Args, Ret>
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

	const instanceSecret = getInstanceSecret(
		'In-app updates not configured (INSTANCE_SECRET missing)'
	);

	const body = await readBody<{ targetVersion?: string }>(event);
	const targetVersion = body?.targetVersion?.trim() || '';

	if (!isValidTargetVersion(targetVersion)) {
		throw createError({
			statusCode: 400,
			message: 'Invalid targetVersion (expected semver like 1.2.3)',
		});
	}

	const currentVersion = process.env['OWLAT_VERSION'] || 'dev';

	// 1. Fetch + cryptographically verify the pinned compose template from
	//    GitHub Releases. The release workflow publishes BOTH
	//    `docker-compose-<v>.yml` AND `docker-compose-<v>.yml.sha256`; the
	//    shared helper downloads both, confirms the file's SHA-256 matches the
	//    published digest, and confirms it pins the expected web image. This is
	//    the ONLY trusted source of a compose template — a caller-supplied one
	//    is never forwarded to the updater. The same helper backs
	//    `/api/self-update` so both routes stay in lock-step.
	const composeTemplate = await resolveVerifiedComposeTemplate({ targetVersion, currentVersion });

	// 2. Look up the current user for audit trail.
	const identity = await client
		.query(api.platformAdmin.platformAdmin.isPlatformAdmin, {})
		.catch(() => null);
	// isPlatformAdmin returned true already (from requirePlatformAdmin), so use
	// a dedicated identity query if available — for now, we don't need the
	// auth user id; use a generic tag.
	void identity;

	// 3. Record the update start.
	const runId = await client.mutation(asPublicMutation(internal.systemUpdates.recordUpdateStart), {
		versionFrom: currentVersion,
		versionTo: targetVersion,
		initiatedBy: 'platform-admin', // TODO: surface actual user id
	});

	// 4. Dispatch to the updater sidecar.
	let updaterResult: {
		success?: boolean;
		error?: string;
		steps?: { step: string; stdout: string; stderr: string }[];
	} = {};
	let updaterOk = false;

	try {
		const updaterResp = await callUpdater('/update', instanceSecret, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ composeTemplate }),
			// Generous timeout — pull + recreate + convex-deploy can take minutes
			signal: AbortSignal.timeout(10 * 60 * 1000),
		});

		updaterResult = (await updaterResp.json()) as typeof updaterResult;
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
