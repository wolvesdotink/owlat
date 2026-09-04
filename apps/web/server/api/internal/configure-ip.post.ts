import { requireInstanceSecret, callUpdater } from '~~/server/utils/updater';

/**
 * Configure-IP proxy endpoint.
 *
 * Caller status: nothing in this repository calls it; the control plane that
 * would is external. The updater exposes its own /configure-ip (see
 * apps/updater/src/server.ts), which is the one this route forwards to.
 * Kept until an operator confirms no control plane still targets this path.
 *
 * Called by the control plane to add/remove floating IPs on this VPS.
 * Validates the instance secret and forwards the request to the updater
 * sidecar running on the same VPS (port 3200).
 */
export default defineEventHandler(async (event) => {
	const instanceSecret = requireInstanceSecret(event, 'Configure-IP not available');

	const body = await readBody(event);

	// Forward to updater sidecar
	const response = await callUpdater('/configure-ip', instanceSecret, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body || {}),
		signal: AbortSignal.timeout(60_000), // 1 min timeout
	});

	const result = await response.json();

	if (!response.ok) {
		throw createError({
			statusCode: response.status,
			message: result.error || 'Configure-IP failed',
			data: result,
		});
	}

	return result;
});
