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

/**
 * The updater's `/update` answer for a release that was applied and whose
 * containers started, but whose stack did not pass the readiness check in
 * time. The release is live; this is a warning to look at the host, not a
 * failed update to retry.
 */
export function isStartedRollout(result: unknown): boolean {
	return (
		typeof result === 'object' &&
		result !== null &&
		(result as { rollout?: unknown }).rollout === 'started'
	);
}

/** An update attempt id the browser mints and the updater records. */
const ATTEMPT_ID = /^[A-Za-z0-9-]{8,64}$/;

export function isUpdateAttemptId(value: unknown): value is string {
	return typeof value === 'string' && ATTEMPT_ID.test(value);
}

/** The updater's record of the last update, as its /health reports it. */
interface LastRollout {
	attempt?: string;
	targetVersion?: string | null;
	phase?: 'applying' | 'verifying' | 'done';
	outcome?: 'healthy' | 'started' | 'partially-applied' | 'failed' | 'interrupted';
	summary?: string;
}

export interface UpdaterHealth {
	status: string;
	timestamp: number;
	version?: string;
	gitSha?: string;
	buildDate?: string;
	containers?: Array<{ service: string; state: string; imageTag?: string }> | string;
	/** Absent from updaters that predate the record. */
	lastRollout?: LastRollout | null;
	rolloutInProgress?: string | null;
}

/**
 * How far an in-flight update has got, as far as /health can tell.
 * - `applying`: nothing shows which step is running.
 * - `recreating`: the web container already runs the target version, so the
 *   pull, deploy and compose steps are behind it and `up` is under way.
 * - `verifying`: the updater reports `up` done and is checking the stack.
 */
export type RolloutStage = 'applying' | 'recreating' | 'verifying';

export type RolloutReading =
	/** Nothing says the update is over yet. */
	| { kind: 'waiting' }
	/** The updater is still working on this attempt. */
	| { kind: 'in-flight'; stage: RolloutStage }
	| { kind: 'complete' }
	/** Applied and started, but not every service became healthy in time. */
	| { kind: 'started'; summary: string }
	| { kind: 'failed'; summary: string };

/**
 * Where the update the progress card is watching stands, from one /health poll.
 *
 * The card used to call an update complete as soon as the web container ran the
 * target version. That happens during `up`, before the updater has checked the
 * rest of the stack, and the updater's answer, the only place its verdict was,
 * normally dies with the web container it recreates. The updater now keeps the
 * verdict and serves it on /health, tagged with the attempt id the browser
 * sent, so a record left by an earlier attempt at the same version is never
 * read as this one's.
 *
 * With no record for this attempt (an updater that predates the record, or the
 * rollout was run by the previous updater and this one was started after it),
 * the web container's version is still the signal.
 */
export function readRolloutProgress(
	health: UpdaterHealth,
	targetVersion: string,
	attempt: string | undefined
): RolloutReading {
	const containers = Array.isArray(health.containers) ? health.containers : [];
	const web = containers.find((c) => c.service === 'web');
	const webOnTarget = Boolean(
		web && web.imageTag === targetVersion && web.state?.includes('running')
	);
	const inFlight = (verifying: boolean): RolloutReading => ({
		kind: 'in-flight',
		stage: verifying ? 'verifying' : webOnTarget ? 'recreating' : 'applying',
	});

	const record = health.lastRollout;
	if (record && attempt && record.attempt === attempt) {
		if (record.phase !== 'done') return inFlight(record.phase === 'verifying');
		const summary = record.summary ?? '';
		if (record.outcome === 'healthy') return { kind: 'complete' };
		if (record.outcome === 'started') return { kind: 'started', summary };
		return { kind: 'failed', summary };
	}
	if (health.rolloutInProgress === 'update') return inFlight(false);

	return webOnTarget ? { kind: 'complete' } : { kind: 'waiting' };
}
