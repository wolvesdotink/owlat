/**
 * EHLO hostname validation and per-IP resolution.
 *
 * Split out of `config.ts` to keep that module under the file-size gate and to
 * co-locate the EHLO-specific concerns: the FCrDNS-oriented FQDN validator run at
 * boot and the per-bind-IP name resolver a multi-IP send path consults. Both are
 * re-exported from `config.ts` so existing importers are unaffected.
 */

import { assertValidOutboundEhloHostname } from '@owlat/shared/outboundIdentity';
import type { MtaConfig } from './config.js';

/**
 * Validate that a string is a publicly-routable, multi-label FQDN suitable for
 * EHLO. RFC 5321 §4.1.1.1 requires the EHLO argument to be the client's fully
 * qualified domain name, and RFC 1912 §2.1 / the 2024 Gmail+Yahoo bulk-sender
 * rules require it to match the IP's PTR record. A bare hostname ('mta1'),
 * 'localhost', a raw IP literal ('203.0.113.10'), or anything with whitespace
 * can never satisfy FCrDNS, so we reject them at startup instead of silently
 * shipping mail that fails authentication.
 */
export function assertValidEhloHostname(value: string, source: string): void {
	assertValidOutboundEhloHostname(value, source);
}

/**
 * Resolve the EHLO hostname to announce when sending from a given bind IP.
 *
 * Returns the per-IP override from `config.ehloHostnames` when one exists for
 * the bind IP, otherwise the global `config.ehloHostname`. This is what lets a
 * multi-IP deployment present each IP's own PTR-matching name so every IP — not
 * just one — can pass FCrDNS.
 */
export function resolveEhloForIp(
	config: Pick<MtaConfig, 'ehloHostname' | 'ehloHostnames'>,
	bindIp: string
): string {
	return config.ehloHostnames[bindIp] ?? config.ehloHostname;
}
