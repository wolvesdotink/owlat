/** Gmail bulk-sender counting helpers. */

import { trySplitZone } from '@owlat/shared/dnsZone';

/**
 * Google's ~5,000-message classifier aggregates mail from the same primary
 * (registrable) domain. Return that PSL-correct identity, or undefined when a
 * malformed/non-public DKIM domain cannot be classified honestly.
 */
export function primarySendingDomain(dkimDomain: string): string | undefined {
	return trySplitZone(dkimDomain)?.registrable;
}
