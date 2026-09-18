/**
 * `GET /api/desktop/update/:target/:arch/:current` — the Tauri updater endpoint
 * a connected desktop app points at instead of GitHub's `latest.json`.
 *
 * Tauri substitutes `{{target}}`, `{{arch}}` and `{{current_version}}` into the
 * endpoint URL and expects either a manifest in its own static format or a
 * `204` meaning "nothing for you". Both come straight from the Convex cache:
 * the manifest is the release's own `latest.json`, stored verbatim and served
 * BYTE-FOR-BYTE, so platform keys this server has never heard of round-trip
 * untouched and the client keeps doing its own platform selection. The path
 * parameters exist for the policy decision and for counting, not for picking a
 * bundle.
 *
 * No session is involved: the updater runs in Rust with no cookie to present,
 * and the answer is public release metadata that is already on GitHub. The
 * route is read-only, bounded to cached rows, and never caches.
 */
import { api } from '@owlat/api';
import { isValidTargetVersion } from '@owlat/shared/releaseArtifacts';
import { publicConvexClient } from '~~/server/utils/publicConvexClient';

/** Tauri's own vocabulary: `linux` / `darwin` / `windows`. */
const TARGET_RE = /^[a-z]+$/;
/** `x86_64`, `aarch64`, `i686`, … */
const ARCH_RE = /^[a-z0-9_]+$/;

export default defineEventHandler(async (event): Promise<string | null> => {
	// An update decision is never cacheable: the policy behind it can change at
	// any moment, and a stale 204 would strand a fleet on an old build.
	setResponseHeader(event, 'Cache-Control', 'no-store');

	const target = getRouterParam(event, 'target') ?? '';
	const arch = getRouterParam(event, 'arch') ?? '';
	const currentVersion = getRouterParam(event, 'current') ?? '';
	if (!TARGET_RE.test(target) || !ARCH_RE.test(arch) || !isValidTargetVersion(currentVersion)) {
		throw createError({ statusCode: 400, statusMessage: 'Bad Request' });
	}

	// 404s when this deployment has no Convex URL configured, which is the same
	// answer an older server gives — the client falls back to GitHub.
	const client = publicConvexClient(event);
	const result = await client.query(api.desktop.updates.manifestForClient, {
		target,
		arch,
		currentVersion,
	});

	if (!result) {
		setResponseStatus(event, 204);
		return null;
	}

	setResponseHeader(event, 'Content-Type', 'application/json');
	return result.manifest;
});
