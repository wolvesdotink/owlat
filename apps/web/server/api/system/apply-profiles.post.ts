import { v } from 'convex/values';
import { requirePlatformAdmin } from '~~/server/utils/requireAdmin';
import { readJsonBody } from '~~/server/utils/jsonBody';
import { getInstanceSecret, callUpdater } from '~~/server/utils/updater';
import { decodeUpdaterReport, type UpdaterReport } from '~~/server/utils/updaterResponses';

/**
 * In-app "Apply & restart" entry point: session-authed proxy from
 * the admin features UI to the updater sidecar's POST /apply-profiles.
 *
 * Mirrors `/api/system/update`'s auth shape — platform-admin session cookie,
 * then the configured INSTANCE_SECRET toward the updater. The body carries the
 * resolved feature-flag snapshot, never profile strings: the updater
 * re-validates every key against the shared registry and derives the compose
 * profiles itself, so this route can only request states the
 * registry can produce.
 */
const applyProfilesBody = v.object({ flags: v.record(v.string(), v.boolean()) });

export default defineEventHandler(async (event) => {
	await requirePlatformAdmin(event);

	const instanceSecret = getInstanceSecret('In-app apply not configured (INSTANCE_SECRET missing)');

	const { flags } = await readJsonBody(event, applyProfilesBody, {
		invalidMessage: 'Invalid flags (expected an object mapping flag keys to booleans)',
	});

	let result: UpdaterReport = {};
	let updaterOk = false;
	let updaterStatus = 0;

	try {
		const updaterResp = await callUpdater('/apply-profiles', instanceSecret, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ flags }),
			// `compose up -d` recreates only changed services, but a cold image
			// pull can still take minutes, and a failed `up` is followed by a
			// recovery and its readiness check before the updater answers.
			signal: AbortSignal.timeout(10 * 60 * 1000),
		});
		// A body that is not an object reports nothing; the status still decides.
		result = decodeUpdaterReport(await updaterResp.json()) ?? {};
		updaterOk = updaterResp.ok;
		updaterStatus = updaterResp.status;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown updater error';
		result = { success: false, error: msg };
	}

	if (updaterStatus === 409) {
		// Another rollout (an update, say) holds the updater. Nothing was
		// changed, and the updater is reachable: not the CLI-fallback case.
		throw createError({
			statusCode: 409,
			message: result.error || 'Another change is still being applied',
			data: result,
		});
	}

	if (!updaterOk) {
		// 502 (not the updater's own status) so the client can distinguish
		// "updater unreachable / refused" — the CLI-fallback branch — from its
		// own auth or validation failures.
		throw createError({
			statusCode: 502,
			message: result.error || 'Applying profiles failed',
			data: result,
		});
	}

	return result;
});
