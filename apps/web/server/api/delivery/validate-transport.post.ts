/**
 * POST /api/delivery/validate-transport
 *
 * The post-setup twin of `/api/setup/validate-provider`: it exercises a
 * delivery transport for real (an API-key request, or a live SMTP handshake +
 * AUTH) so an admin can TEST new credentials in the in-app transport editor
 * BEFORE applying them — the same live check the setup wizard runs, moved
 * behind the running instance's admin gate instead of setup mode.
 *
 * Gated on the `organization:manage` floor (`requireOrgAdmin`), NOT on
 * `OWLAT_SETUP_MODE` (setup is long over on a running instance). Body parsing
 * and dispatch are `server/utils/sendProviderProbe.ts`, shared with the setup
 * endpoint: which kinds can be tested, and with which validator, is the
 * send-provider catalog's `setupProbe` declaration.
 *
 * Body (API-key probe): { provider, apiKey: string }
 * Body (SMTP relay probe): { provider, smtp: { host, port, secure, username,
 *   password } }
 * Response: { ok: boolean, message: string }
 *
 * A kind with no `setupProbe` (SES, Mandrill, the built-in MTA) is refused
 * with a 400 rather than pretending to test it: its real proof is the "Send a
 * test email" card after applying.
 */

import { requireOrgAdmin } from '~~/server/utils/requireOrgAdmin';
import { parseProbeBody, runSendProviderProbe } from '~~/server/utils/sendProviderProbe';

export default defineEventHandler(async (event): Promise<{ ok: boolean; message: string }> => {
	await requireOrgAdmin(event);

	const input = parseProbeBody(await readBody(event));
	return runSendProviderProbe(input.provider, input);
});
