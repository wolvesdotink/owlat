/**
 * GET /profile-state — report the CURRENTLY APPLIED profile state of the host
 * stack, so the admin UI can rebuild its "Services out of sync" banner after a
 * reload (or in a second browser) instead of trusting per-tab memory.
 *
 * Strictly read-only: it parses `<OWLAT_DIR>/.env` through the shared readers
 * and reports `docker compose ps` through the same parser /health uses. The
 * caller (the Nuxt /api/system/profile-drift route) owns the comparison against
 * the expected profiles — the updater carries no flag state of its own.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	parseComposeProfilesFromEnv,
	parseDeliveryProviderFromEnv,
} from '@owlat/shared/composeOverride';
import { errorMessage } from '@owlat/shared';
import { isRateLimited } from './security.js';
import { composePsServices, json, OWLAT_DIR, requireAuth } from './http.js';

export function handleProfileState(req: IncomingMessage, res: ServerResponse) {
	if (!requireAuth(req, res)) return;

	// Read-only and cheap (one file read + one `compose ps`), so it gets
	// /health's budget rather than the write endpoints' tighter one.
	if (isRateLimited('profile-state', 20, 60_000)) {
		return json(res, 429, { error: 'Too many profile-state requests.' });
	}

	let envContent: string;
	try {
		envContent = readFileSync(join(OWLAT_DIR, '.env'), 'utf-8');
	} catch (err) {
		return json(res, 500, { error: `Cannot read .env: ${errorMessage(err)}` });
	}

	const { containers, raw } = composePsServices();

	json(res, 200, {
		profiles: parseComposeProfilesFromEnv(envContent),
		// EMAIL_PROVIDER decides the env-driven deliveryProvider→mta rule; the
		// route needs it to derive the same expected set /apply-profiles would.
		deliveryProvider: parseDeliveryProviderFromEnv(envContent),
		services: containers.length > 0 ? containers : raw,
	});
}
