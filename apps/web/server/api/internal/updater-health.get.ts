import { requirePlatformAdmin } from '~~/server/utils/requireAdmin';
import { getInstanceSecret, callUpdater } from '~~/server/utils/updater';

/**
 * Session-authed proxy to the updater sidecar's /health endpoint.
 *
 * Returns container status + per-service version info. The UI polls this
 * during and after an update to verify the new images came up cleanly.
 *
 * Note: distinct from `/api/internal/health.get.ts`, which is the aggregated
 * stack health check for the hosted-cloud control plane (X-Instance-Secret
 * auth).
 */
export default defineEventHandler(async (event) => {
	await requirePlatformAdmin(event);

	const instanceSecret = getInstanceSecret('Updater not configured (INSTANCE_SECRET missing)');

	try {
		const resp = await callUpdater('/health', instanceSecret, {
			method: 'GET',
			signal: AbortSignal.timeout(10_000),
		});

		if (!resp.ok) {
			throw createError({
				statusCode: resp.status,
				message: `Updater health check returned ${resp.status}`,
			});
		}

		return await resp.json();
	} catch (err) {
		// If the updater is mid-restart (unlikely but possible), treat it as
		// a 503 — the UI's poller retries with backoff.
		if (err instanceof Error && err.name === 'TimeoutError') {
			throw createError({ statusCode: 504, message: 'Updater timeout' });
		}
		const msg = err instanceof Error ? err.message : 'Unknown error';
		throw createError({
			statusCode: 502,
			message: `Could not reach updater: ${msg}`,
		});
	}
});
