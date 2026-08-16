import { requirePlatformAdmin } from '~~/server/utils/requireAdmin';
import { getInstanceSecret, callUpdater } from '~~/server/utils/updater';

/**
 * In-app "Apply & restart" entry point (plan D4): session-authed proxy from
 * the admin features UI to the updater sidecar's POST /apply-profiles.
 *
 * Mirrors `/api/system/update`'s auth shape — platform-admin session cookie,
 * then the configured INSTANCE_SECRET toward the updater. The body carries the
 * resolved feature-flag snapshot, never profile strings: the updater
 * re-validates every key against the shared registry and derives the compose
 * profiles itself (decision D3), so this route can only request states the
 * registry can produce.
 */
export default defineEventHandler(async (event) => {
	await requirePlatformAdmin(event);

	const instanceSecret = getInstanceSecret('In-app apply not configured (INSTANCE_SECRET missing)');

	const body = await readBody<{ flags?: unknown }>(event);
	const flags = body?.flags;
	if (
		typeof flags !== 'object' ||
		flags === null ||
		Array.isArray(flags) ||
		Object.values(flags).some((value) => typeof value !== 'boolean')
	) {
		throw createError({
			statusCode: 400,
			message: 'Invalid flags (expected an object mapping flag keys to booleans)',
		});
	}

	let result: {
		success?: boolean;
		error?: string;
		profiles?: string[];
		steps?: { step: string; stdout?: string; stderr?: string }[];
		services?: unknown;
	} = {};
	let updaterOk = false;

	try {
		const updaterResp = await callUpdater('/apply-profiles', instanceSecret, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ flags }),
			// `compose up -d` recreates only changed services, but a cold image
			// pull can still take minutes.
			signal: AbortSignal.timeout(5 * 60 * 1000),
		});
		result = (await updaterResp.json()) as typeof result;
		updaterOk = updaterResp.ok;
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Unknown updater error';
		result = { success: false, error: msg };
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
