/**
 * The Mandrill subaccounts this deployment sends under (#1243).
 *
 * Each configured Mandrill transport (the default one and every named
 * `mandrill#<key>` instance) sends under the subaccount its
 * `MANDRILL_SUBACCOUNT` names, read exactly as the send adapter reads it in
 * `./index.ts`: the raw value, an empty one meaning "none". A transport with no
 * subaccount sends on the account's default, which this answers as `null`.
 *
 * Isolate-safe (no `'use node'`), so the webhook adapter can ask it.
 */

import { listSendTransports } from '../transports';
import { transportEnvOptional } from '../transportEnv';

/**
 * Every subaccount Owlat's Mandrill traffic is sent under, `null` meaning the
 * account's default. Read on every call, so an env change applies to the next
 * webhook without a redeploy.
 */
export function ownMandrillSubaccounts(): ReadonlySet<string | null> {
	const own = new Set<string | null>();
	for (const transport of listSendTransports()) {
		if (transport.kind !== 'mandrill') continue;
		own.add(transportEnvOptional(transport, 'MANDRILL_SUBACCOUNT') || null);
	}
	return own;
}
