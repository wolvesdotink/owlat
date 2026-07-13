/**
 * Read the ACTIVE transport's effective outbound identities from the environment
 * so the outbound DMARC-alignment guard (`@owlat/shared` `checkFromAlignment` /
 * `summarizeOutboundAlignment`) can tell whether the way this instance signs and
 * bounces mail aligns with the domains it sends From.
 *
 * The two identities are non-secret, DNS-facing values (never credentials):
 *  - `dkimDomain`       the DKIM `d=` the transport signs with (`OUTBOUND_DKIM_DOMAIN`),
 *                       or `null` when it signs per-From-domain (the built-in MTA).
 *  - `returnPathDomain` the envelope return-path / bounce domain
 *                       (`MTA_RETURN_PATH_DOMAIN`), or `null` when per-From-domain.
 *
 * Kept in one place so the readiness panel (`delivery/status.ts`) and the campaign
 * From-picker (`campaigns/senders.ts`) derive the SAME facts instead of forking
 * the env reads.
 */

import type { OutboundTransportFacts, SendTransportKind } from '@owlat/shared';
import { getOptional } from './env';
import { isSendProviderKind } from './sendProviders/types';

/** The active transport kind — `EMAIL_PROVIDER` when it names a real adapter, else the built-in MTA. */
function activeTransportKind(): SendTransportKind {
	const provider = getOptional('EMAIL_PROVIDER');
	return isSendProviderKind(provider) ? provider : 'mta';
}

/** Build the active transport's effective outbound identities from the environment. */
export function outboundTransportFacts(): OutboundTransportFacts {
	return {
		kind: activeTransportKind(),
		returnPathDomain: getOptional('MTA_RETURN_PATH_DOMAIN') ?? null,
		dkimDomain: getOptional('OUTBOUND_DKIM_DOMAIN') ?? null,
	};
}
