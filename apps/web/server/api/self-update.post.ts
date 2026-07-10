import { isValidTargetVersion } from '@owlat/shared/composeVerify';
import { requireInstanceSecret, callUpdater } from '~~/server/utils/updater';
import { resolveVerifiedComposeTemplate } from '~~/server/utils/composeUpdate';

/**
 * Self-update proxy endpoint.
 *
 * Called by the control plane to trigger a VPS update. Validates the instance
 * secret and dispatches to the updater sidecar running on the same VPS
 * (port 3200).
 *
 * The caller only supplies a `targetVersion`. The compose template that the
 * updater applies is downloaded and SHA-256-verified here against Owlat's
 * published release artifacts — exactly like the session-authed
 * `/api/system/update` route, via the same shared helper. A caller-supplied
 * `composeTemplate` is never forwarded: an INSTANCE_SECRET holder must not be
 * able to push an arbitrary compose file (and therefore arbitrary container
 * images → RCE) to the host.
 */
export default defineEventHandler(async (event) => {
	const instanceSecret = requireInstanceSecret(event, 'Self-update not configured');

	const body = await readBody<{ targetVersion?: string }>(event);
	const targetVersion = body?.targetVersion?.trim() || '';

	if (!isValidTargetVersion(targetVersion)) {
		throw createError({
			statusCode: 400,
			message: 'Invalid targetVersion (expected semver like 1.2.3)',
		});
	}

	const currentVersion = process.env['OWLAT_VERSION'] || 'dev';

	// Only a cryptographically verified, release-pinned template is dispatched.
	const composeTemplate = await resolveVerifiedComposeTemplate({ targetVersion, currentVersion });

	// Forward the verified template to the updater sidecar.
	const response = await callUpdater('/update', instanceSecret, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ composeTemplate }),
		// Generous timeout — pull + recreate + convex-deploy can take minutes.
		signal: AbortSignal.timeout(10 * 60 * 1000),
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
