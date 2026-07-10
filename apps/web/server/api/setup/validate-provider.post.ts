/**
 * POST /api/setup/validate-provider
 *
 * Validates a delivery/integration provider by exercising it for real. API-key
 * providers fire an authenticated request; the generic SMTP relay runs a real
 * SMTP handshake + AUTH exchange. Only callable when the instance is in setup
 * mode (OWLAT_SETUP_MODE=true).
 *
 * Body (API-key provider): { provider: 'resend' | 'openai' | 'openrouter' |
 *   'posthog' | 'safebrowsing', apiKey: string, host?: string }
 * Body (SMTP relay): { provider: 'smtp', smtp: { host, port, secure, username,
 *   password } }
 * Response: { ok: boolean, message: string }
 *
 * The actual validation logic lives in `@owlat/shared/setupValidators`, shared
 * with the `owlat-setup` CLI so the two never drift on which outcomes count as
 * valid.
 */

import {
	validateProvider,
	validateSmtpRelay,
	type SetupProvider,
	type SmtpRelayInput,
} from '@owlat/shared/setupValidators';

interface ValidateBody {
	provider: SetupProvider | 'smtp';
	apiKey?: string;
	host?: string;
	smtp?: Partial<SmtpRelayInput>;
}

export default defineEventHandler(async (event): Promise<{ ok: boolean; message: string }> => {
	if (process.env['OWLAT_SETUP_MODE'] !== 'true') {
		throw createError({ statusCode: 403, message: 'Setup mode is not active.' });
	}

	const body = await readBody<ValidateBody>(event);
	if (!body?.provider) {
		throw createError({ statusCode: 400, message: 'provider is required.' });
	}

	if (body.provider === 'smtp') {
		const smtp = body.smtp;
		if (!smtp?.host || !smtp?.username || !smtp?.password) {
			throw createError({
				statusCode: 400,
				message: 'smtp.host, smtp.username, and smtp.password are required.',
			});
		}
		return validateSmtpRelay({
			host: smtp.host,
			port: typeof smtp.port === 'number' ? smtp.port : 587,
			secure: smtp.secure === true,
			username: smtp.username,
			password: smtp.password,
		});
	}

	if (!body.apiKey) {
		throw createError({ statusCode: 400, message: 'apiKey is required.' });
	}

	return validateProvider(body.provider, body.apiKey, body.host);
});
