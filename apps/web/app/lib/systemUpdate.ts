/**
 * Client-side helpers for the platform-admin in-app update flow
 * (Settings → System & Updates).
 */

/**
 * Did the server answer the `POST /api/system/update` that just threw?
 *
 * The updater's last step recreates the web container, which kills the
 * in-flight request from under the browser — an update that is going exactly to
 * plan ends in a throw with no response behind it. Treating that as a failure
 * replaced the progress card with a red banner while the update carried on, so
 * only a throw that carries an HTTP status (a rejected version, a missing
 * instance secret, an updater-reported failure) is conclusive. Anything else
 * leaves the verdict to the health poller, which either sees the new version
 * come up or times out.
 */
export function updateRequestWasAnswered(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const statusCode = (error as { statusCode?: unknown }).statusCode;
	return typeof statusCode === 'number' && statusCode > 0;
}
