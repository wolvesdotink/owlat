/**
 * POST /api/delivery/validate-transport
 *
 * The post-setup twin of `/api/setup/validate-provider`: it exercises a
 * delivery transport for real (a Resend API call, or a live SMTP handshake +
 * AUTH) so an admin can TEST new credentials in the in-app transport editor
 * BEFORE applying them — the same live handshake the setup wizard runs, moved
 * behind the running instance's admin gate instead of setup mode.
 *
 * Gated on the `organization:manage` floor (`requireOrgAdmin`), NOT on
 * `OWLAT_SETUP_MODE` (setup is long over on a running instance). The validation
 * logic is the shared `@owlat/shared/setupValidators`, so the editor and the
 * wizard can never drift on which outcomes count as valid.
 *
 * Body (Resend): { provider: 'resend', apiKey: string }
 * Body (SMTP relay): { provider: 'smtp', smtp: { host, port, secure, username,
 *   password } }
 * Response: { ok: boolean, message: string }
 *
 * SES and the built-in MTA have no pre-apply network validator (the wizard has
 * none either): their real proof is the existing "Send a test email" card after
 * applying. This endpoint rejects those kinds with a clear message rather than
 * pretending to test them.
 */

import {
	validateResendKey,
	validateSmtpRelay,
	type SmtpRelayInput,
} from '@owlat/shared/setupValidators';
import { requireOrgAdmin } from '~~/server/utils/requireOrgAdmin';

interface ValidateBody {
	provider: 'resend' | 'smtp';
	apiKey?: string;
	smtp?: Partial<SmtpRelayInput>;
}

export default defineEventHandler(async (event): Promise<{ ok: boolean; message: string }> => {
	await requireOrgAdmin(event);

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
		// A present-but-non-numeric port must fail loudly rather than being silently
		// coerced to 587 — otherwise we could report success for a different port
		// than the caller asked about. Absent ⇒ backend default 587.
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

	if (body.provider === 'resend') {
		if (!body.apiKey) {
			throw createError({ statusCode: 400, message: 'apiKey is required.' });
		}
		return validateResendKey(body.apiKey);
	}

	throw createError({
		statusCode: 400,
		message:
			'Only Resend and SMTP relays can be tested before applying. Apply the change, then use "Send a test email" to confirm SES or your own MTA.',
	});
});
