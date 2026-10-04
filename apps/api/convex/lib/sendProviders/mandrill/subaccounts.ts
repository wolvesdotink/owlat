/**
 * The Mandrill subaccounts this deployment sends under (#1243).
 *
 * Each CONFIGURED Mandrill transport sends under the subaccount its
 * `MANDRILL_SUBACCOUNT` names, read exactly as the send adapter reads it in
 * `./index.ts`: the raw value, an empty one meaning "none". A transport with no
 * subaccount sends on the account's default, which this answers as `null`.
 *
 * Configured means its API key is set. `listSendTransports` lists every
 * default instance whether or not it has credentials, and an unconfigured
 * default sends nothing, so counting it would put the account default in scope
 * for a deployment that only sends through `mandrill#eu`. Named instances are
 * listed only when configured already; the key check holds them to the same
 * rule.
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
		if (!transportEnvOptional(transport, 'MANDRILL_API_KEY')) continue;
		own.add(transportEnvOptional(transport, 'MANDRILL_SUBACCOUNT') || null);
	}
	return own;
}
