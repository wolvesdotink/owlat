/**
 * `GET /api/desktop/update-policy` — what this instance does about desktop
 * updates, and the capability probe that tells a desktop app whether to ask it
 * at all.
 *
 * A server that predates server-managed updates has no such route and answers
 * 404; the app reads that as "this instance does not manage updates" and uses
 * the GitHub endpoint baked into its config, exactly as it does today. A server
 * that answers tells the app the mode, the channel and what the newest cached
 * release is, which is what the device page shows next to the version.
 *
 * Public and session-free like `/api/instance-info`: the webview fetches it
 * cross-origin with `credentials: 'omit'`, and every field is either the
 * operator's own policy or release metadata already published on GitHub.
 */
import { api } from '@owlat/api';
import { publicConvexClient } from '~~/server/utils/publicConvexClient';

export default defineEventHandler(async (event) => {
	// The desktop webview origins (`tauri://localhost` / `https://tauri.localhost`)
	// are allow-listed globally in nuxt.config.ts `security.corsHandler.origin`,
	// which reflects the matching origin back; setting ACAO here would emit a
	// conflicting second header.
	setResponseHeader(event, 'Cache-Control', 'no-store');

	const client = publicConvexClient(event);
	return await client.query(api.desktop.updates.getPolicySummary, {});
});
