import type { Id } from '@owlat/api/dataModel';
import { api } from '@owlat/api';
import { isValidTargetVersion } from '@owlat/shared/releaseArtifacts';
import { requirePlatformAdmin } from '~~/server/utils/requireAdmin';
import { resolveVerifiedComposeTemplate } from '~~/server/utils/composeUpdate';
import { getInstanceSecret, callUpdater } from '~~/server/utils/updater';
import {
	UPDATER_REPORT_MARKER,
	isStartedRollout,
	isUpdateAttemptId,
	isUpdaterRefusal,
} from '~/lib/systemUpdate';

/**
 * Pull + convex-deploy + recreate, then the updater's readiness wait, which
 * follows the healthcheck cadence services declare (ClamAV: up to ~11 min).
 */
const UPDATER_TIMEOUT_MS = 30 * 60 * 1000;

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
 *   3. Record an "updateRun" doc via api.systemUpdates.recordUpdateStart.
 *   4. POST to http://updater:3200/update with the downloaded compose template.
 *   5. Record result via api.systemUpdates.recordUpdateFinish.
 *   6. Return the updater's response to the client.
 *
 * A rollout the updater reports as `started` (applied, containers started,
 * but not every service healthy in time) is not a failed update: the release
 * is live and re-running it changes nothing. It is recorded as a success
 * carrying the updater's note, and answered 200 with the note as `warning`.
 * A 409 (another rollout holds the updater) or 429 (its rate limit) means the
 * update never started: it is passed on as such, and its history row is taken
 * back instead of being recorded as a failed update.
 *
 * Both record calls address the PUBLIC function surface, because that is the
 * only one a `ConvexHttpClient` can reach — an `internal*` reference forwarded
 * from here resolves to nothing ("Could not find public function for …") and
 * took the whole route down with a 500. They are platform-admin gated inside
 * Convex, and the audit actor is derived from the session there rather than
 * passed in from here.
 *
 * The web container will be restarted by the updater mid-flight. The UI
 * handles this by polling /api/internal/updater-health with retry.
 */
export default defineEventHandler(async (event) => {
	const client = await requirePlatformAdmin(event);

	const instanceSecret = getInstanceSecret(
		'In-app updates not configured (INSTANCE_SECRET missing)'
	);

	const body = await readBody<{ targetVersion?: string; attempt?: unknown }>(event);
	const targetVersion = body?.targetVersion?.trim() || '';
	// The browser's id for this attempt; the updater echoes it on /health so the
	// progress card can find this update's verdict after the restart.
	const rawAttempt = body?.attempt;
	const attempt = isUpdateAttemptId(rawAttempt) ? rawAttempt : undefined;

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

	// 2. Record the update start. Best-effort: the audit row is not worth
	//    refusing to update over. An operator reaching for "Update now" is
	//    often reaching for it BECAUSE something is unwell, and a Convex that
	//    cannot take this write must not be what stops the update that fixes
	//    it — which is exactly what happened while this call was unroutable.
	let runId: Id<'systemUpdates'> | null = null;
	try {
		runId = await client.mutation(api.systemUpdates.recordUpdateStart, {
			versionFrom: currentVersion,
			versionTo: targetVersion,
		});
	} catch (err) {
		console.error('[system/update] could not record the update start', err);
	}

	// 3. Dispatch to the updater sidecar.
	let updaterResult: {
		success?: boolean;
		error?: string;
		rollout?: string;
		steps?: { step: string; ok?: boolean; stdout: string; stderr: string }[];
	} = {};
	let updaterOk = false;
	let updaterStatus = 0;

	try {
		const updaterResp = await callUpdater('/update', instanceSecret, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ composeTemplate, ...(attempt ? { attempt } : {}) }),
			signal: AbortSignal.timeout(UPDATER_TIMEOUT_MS),
		});

		updaterResult = (await updaterResp.json()) as typeof updaterResult;
		updaterOk = updaterResp.ok;
		updaterStatus = updaterResp.status;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown updater error';
		updaterResult = { success: false, error: msg };
		updaterOk = false;
	}

	const started = !updaterOk && isStartedRollout(updaterResult);
	const refused = !updaterOk && isUpdaterRefusal(updaterStatus);

	// 4. Record the result. (Uses `client` which we created in requirePlatformAdmin;
	// its auth JWT may have expired mid-update if the web container restarted —
	// this call is purely best-effort audit.) An update the updater refused to
	// start never ran: its row is taken back rather than recorded as failed.
	if (runId) {
		try {
			if (refused) {
				await client.mutation(api.systemUpdates.withdrawUpdateStart, { runId });
			} else {
				await client.mutation(api.systemUpdates.recordUpdateFinish, {
					runId,
					status: updaterOk || started ? 'success' : 'failed',
					steps: updaterResult.steps,
					error: updaterResult.error,
				});
			}
		} catch {
			// Convex may have dropped auth during the update. Ignore — the UI will
			// reconcile on the next page load by reading the history.
		}
	}

	if (started) {
		console.warn('[system/update] update applied, not yet healthy:', updaterResult.error);
		return {
			success: true,
			rollout: 'started',
			warning: updaterResult.error,
			runId,
			versionFrom: currentVersion,
			versionTo: targetVersion,
			steps: updaterResult.steps,
		};
	}

	if (!updaterOk) {
		// The browser only ever shows the status line (`[POST] "…": 502`), so
		// without this the reason — which the sidecar states precisely, down to
		// the host command that fixes it — exists nowhere an operator can read.
		// `docker logs owlat-web-1` is where they look next.
		console.error(
			'[system/update] update failed:',
			updaterResult.error || 'no error reported',
			(updaterResult.steps ?? [])
				.filter((step) => step.ok === false)
				.map((step) => `${step.step}: ${step.stderr}`)
				.join(' | ')
		);
		// The marker is what tells the browser this 502 is OURS. The rollout's
		// last step recreates this very container, so the same request also ends
		// in a 502 when everything went right — Caddy's, for an upstream that
		// went away mid-answer. Only one of the two carries a report.
		throw createError({
			// 409/429: the updater refused to start (another rollout holds it, or
			// its rate limit does); nothing was changed.
			statusCode: refused ? updaterStatus : 502,
			message: updaterResult.error || 'Update failed',
			data: { [UPDATER_REPORT_MARKER]: true, ...updaterResult },
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
