import { requirePlatformAdmin } from '~~/server/utils/requireAdmin';
import { getInstanceSecret, callUpdater } from '~~/server/utils/updater';

/**
 * Session-authed proxy to the updater's POST /port-checks — the admin card's
 * "Re-check ports" button.
 *
 * Auth mirrors apply-profiles.post.ts: platform-admin session cookie here, the
 * configured INSTANCE_SECRET toward the updater. Nothing in the request shapes
 * what is probed; the updater derives the whole list from the host `.env`, so
 * this route cannot be turned into a port scanner pointed at a third party.
 *
 * An unreachable sidecar answers `reachable: false` rather than an error status:
 * an instance that runs no updater (a dev tree, a hand-rolled compose) has no
 * way to run these probes at all, and the card says exactly that instead of
 * rendering a failure the operator cannot act on.
 */
interface PortChecksResult {
	reachable: boolean;
	verdict?: string;
	checkedAt?: number;
	checks?: unknown;
	error?: string;
}

export default defineEventHandler(async (event): Promise<PortChecksResult> => {
	await requirePlatformAdmin(event);

	let instanceSecret: string;
	try {
		instanceSecret = getInstanceSecret('Port checks not configured (INSTANCE_SECRET missing)');
	} catch (err) {
		return { reachable: false, error: errorText(err) };
	}

	try {
		const resp = await callUpdater('/port-checks', instanceSecret, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			// Ten probes run in parallel behind a five-second socket budget; this
			// leaves room for the slowest of them plus the sidecar's own overhead.
			signal: AbortSignal.timeout(30_000),
		});
		const body = (await resp.json()) as PortChecksResult;
		if (!resp.ok) {
			return { reachable: false, error: body.error || `Updater returned ${resp.status}` };
		}
		return { ...body, reachable: true };
	} catch (err) {
		return { reachable: false, error: errorText(err) };
	}
});

function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'object' && err !== null && 'message' in err) {
		return String((err as { message: unknown }).message);
	}
	return 'Unknown updater error';
}
