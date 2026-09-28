/**
 * POST /api/setup/validate-provider
 *
 * Validates a delivery/integration provider by exercising it for real. API-key
 * providers fire an authenticated request; the generic SMTP relay runs a real
 * SMTP handshake + AUTH exchange. Callable only when the instance is in setup
 * mode (OWLAT_SETUP_MODE=true) AND the caller echoes the one-time setup token in
 * the X-Setup-Token header (see server/utils/setupToken.ts).
 *
 * Body (API-key provider): { provider, apiKey: string, host?: string }
 * Body (SMTP relay): { provider, smtp: { host, port, secure, username,
 *   password } }
 * Response: { ok: boolean, message: string }
 *
 * A send provider whose catalog entry declares a `setupProbe` goes through
 * `server/utils/sendProviderProbe.ts`, the same parsing and dispatch the
 * transport editor's `/api/delivery/validate-transport` uses. Every other
 * provider (the AI, analytics and Safe Browsing keys) goes through
 * `validateProvider` from `@owlat/shared/setupValidators`, shared with the
 * `owlat-setup` CLI so the two never drift on which outcomes count as valid.
 */

import { validateProvider, type SetupProvider } from '@owlat/shared/setupValidators';
import {
	hasSendProviderProbe,
	parseProbeBody,
	requireApiKey,
	runSendProviderProbe,
} from '~~/server/utils/sendProviderProbe';

export default defineEventHandler(async (event): Promise<{ ok: boolean; message: string }> => {
	if (process.env['OWLAT_SETUP_MODE'] !== 'true') {
		throw createError({ statusCode: 403, message: 'Setup mode is not active.' });
	}
	// Setup mode is a precondition, not authorization: require the one-time setup
	// token so an unauthenticated caller cannot exercise the operator's provider
	// credentials. Missing/wrong token -> 401.
	requireSetupToken(event);

	const input = parseProbeBody(await readBody(event));
	if (hasSendProviderProbe(input.provider)) {
		return runSendProviderProbe(input.provider, input);
	}

	const apiKey = requireApiKey(input);
	return validateProvider(input.provider as SetupProvider, apiKey, input.host);
});
