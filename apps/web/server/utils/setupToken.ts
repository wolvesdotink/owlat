import type { H3Event } from 'h3';
import { isValidSetupToken } from '@owlat/shared/setupToken';

/**
 * Per-caller auth for the unauthenticated first-run setup endpoints.
 *
 * `OWLAT_SETUP_MODE=true` alone is NOT an authorization boundary: it only says
 * the instance has no admin yet, so without this check the first caller to reach
 * `/api/setup/apply` would create the platform-admin account (attacker-chosen
 * email + password) and rewrite `.env` — full instance takeover. The `owlat
 * setup` CLI mints a high-entropy setup token when it enables setup mode, writes
 * it to the root-owned `.env` (surfaced to this container as
 * `OWLAT_SETUP_TOKEN`), and prints it to the console. The wizard must echo it in
 * the `X-Setup-Token` header; this guard verifies it with a constant-time
 * compare and fails closed when the token is unconfigured, missing, or wrong.
 */
export function requireSetupToken(event: H3Event): void {
	const expected = process.env['OWLAT_SETUP_TOKEN'];
	const provided = getHeader(event, 'x-setup-token');
	if (!isValidSetupToken(provided, expected)) {
		throw createError({
			statusCode: 401,
			message:
				'Invalid or missing setup token. Copy the setup token printed by `owlat setup` into the wizard, then retry.',
		});
	}
}
