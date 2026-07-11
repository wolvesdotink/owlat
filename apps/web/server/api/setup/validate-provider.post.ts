/**
 * POST /api/setup/validate-provider
 *
 * Validates a delivery/integration provider by exercising it for real. API-key
 * providers fire an authenticated request; the generic SMTP relay runs a real
 * SMTP handshake + AUTH exchange. Callable only when the instance is in setup
 * mode (OWLAT_SETUP_MODE=true) AND the caller echoes the one-time setup token in
 * the X-Setup-Token header (see server/utils/setupToken.ts).
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
import { requireSetupToken } from '~~/server/utils/setupToken';

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
	// Setup mode is a precondition, not authorization: require the one-time setup
	// token so an unauthenticated caller cannot exercise the operator's provider
	// credentials. Missing/wrong token -> 401.
	requireSetupToken(event);

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
		// A present-but-non-numeric port must fail loudly rather than being
		// silently coerced to 587 — otherwise the endpoint could report success
		// for a different port than the caller asked about. Absent ⇒ backend 587.
		if (smtp.port !== undefined && typeof smtp.port !== 'number') {
			throw createError({ statusCode: 400, message: 'smtp.port must be a number.' });
		}
		return validateSmtpRelay({
			host: smtp.host,
			port: smtp.port ?? 587,
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
