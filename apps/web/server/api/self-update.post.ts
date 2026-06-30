import { requireInstanceSecret, callUpdater } from '~~/server/utils/updater';

/**
 * Self-update proxy endpoint.
 *
 * Called by the control plane to trigger a VPS update.
 * Validates the instance secret and forwards the request to the updater
 * sidecar running on the same VPS (port 3200).
 */
export default defineEventHandler(async (event) => {
	const instanceSecret = requireInstanceSecret(event, 'Self-update not configured');

	const body = await readBody(event);

	// Forward to updater sidecar
	const response = await callUpdater('/update', instanceSecret, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body || {}),
		signal: AbortSignal.timeout(120_000), // 2 min timeout for pull + restart
	});

	const result = await response.json();

	if (!response.ok) {
		throw createError({
			statusCode: response.status,
			message: result.error || 'Update failed',
			data: result,
		});
	}

	return result;
});
