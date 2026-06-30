/**
 * POST /api/setup/validate-provider
 *
 * Validates a third-party provider credential by making a real API request.
 * Only callable when the instance is in setup mode (OWLAT_SETUP_MODE=true).
 *
 * Body: { provider: 'resend' | 'openai' | 'openrouter' | 'posthog' | 'safebrowsing',
 *         apiKey: string, host?: string }
 * Response: { ok: boolean, message: string }
 *
 * The actual validation logic lives in `@owlat/shared/setupValidators`, shared
 * with the `owlat-setup` CLI so the two never drift on which status codes count
 * as valid.
 */

import { validateProvider, type SetupProvider } from '@owlat/shared/setupValidators';

interface ValidateBody {
	provider: SetupProvider;
	apiKey: string;
	host?: string;
}

export default defineEventHandler(async (event): Promise<{ ok: boolean; message: string }> => {
	if (process.env['OWLAT_SETUP_MODE'] !== 'true') {
		throw createError({ statusCode: 403, message: 'Setup mode is not active.' });
	}

	const body = await readBody<ValidateBody>(event);
	if (!body?.provider || !body?.apiKey) {
		throw createError({ statusCode: 400, message: 'provider and apiKey are required.' });
	}

	return validateProvider(body.provider, body.apiKey, body.host);
});
