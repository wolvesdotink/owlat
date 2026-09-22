/**
 * Client-side helpers for the platform-admin in-app update flow
 * (Settings → System & Updates).
 */

/**
 * The marker `/api/system/update` puts in its error payload so the browser can
 * tell the route's own verdict from the reverse proxy's.
 */
export const UPDATER_REPORT_MARKER = 'updaterReport';

/**
 * Statuses Caddy synthesises when it cannot reach `web`, or when the answer
 * never arrives: exactly the shape of the update's last step recreating the
 * container that is serving the request.
 */
const PROXY_STATUSES = new Set([502, 504]);

/** Does this error payload carry the update route's own report? */
function carriesUpdaterReport(error: unknown): boolean {
	const body = (error as { data?: { data?: unknown } }).data?.data;
	return typeof body === 'object' && body !== null && UPDATER_REPORT_MARKER in body;
}

/**
 * Did the server answer the `POST /api/system/update` that just threw?
 *
 * The updater's last step recreates the web container, which kills the
 * in-flight request from under the browser — an update that is going exactly to
 * plan ends in a throw, and treating that as a failure replaces the progress
 * card with a red banner while the update carries on.
 *
 * Which is what it did, because the status code alone cannot decide this. The
 * request does not die silently: Caddy watches its upstream disappear and
 * answers the browser with a bodiless **502**, and the route's own
 * updater-reported failure is a 502 as well. A rollout that succeeded and one
 * that failed arrive at the browser under the same number.
 *
 * So the discriminator is the body. Ours carries the sidecar's report; the
 * proxy's carries nothing. Every other status — a rejected version, a missing
 * instance secret, a session that is not a platform admin's — is conclusive on
 * its own, since no proxy invents those. Anything left over is the update still
 * running, and the verdict belongs to the health poller, which either sees the
 * new version come up or times out.
 */
export function updateRequestWasAnswered(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const statusCode = (error as { statusCode?: unknown }).statusCode;
	if (typeof statusCode !== 'number' || statusCode <= 0) return false;
	return PROXY_STATUSES.has(statusCode) ? carriesUpdaterReport(error) : true;
}

/**
 * The reason an answered update failed, in the words the sidecar used.
 *
 * `FetchError.message` is built from the status line alone, so the banner used
 * to read `[POST] "/api/system/update": 502` and nothing else — the reason the
 * route took care to forward existed only in `docker logs owlat-web-1`.
 */
export function updateFailureMessage(error: unknown, fallback: string): string {
	if (typeof error !== 'object' || error === null) return fallback;
	const payload = (error as { data?: { data?: { error?: unknown }; message?: unknown } }).data;
	const reported = payload?.data?.error;
	if (typeof reported === 'string' && reported.trim()) return reported;
	if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message;
	return error instanceof Error && error.message ? error.message : fallback;
}
