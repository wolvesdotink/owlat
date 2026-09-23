/**
 * Per-IP EHLO overrides for the built-in MTA, as a small (IP, hostname) table.
 *
 * A multi-IP deployment whose addresses have different PTR names sets
 * `EHLO_HOSTNAMES`, a JSON map from each sending IP to the hostname it greets
 * with. Operators used to type that JSON by hand in the setup wizard; the
 * Delivery provider page now builds it from rows, using the same parser the
 * MTA and the setup preflight use, so the value it hands over is one they will
 * accept.
 *
 * Module scope, so failures are catalog keys, never sentences.
 */
import {
	assertValidOutboundEhloHostname,
	parseCanonicalEhloHostnames,
} from '@owlat/shared/outboundIdentity';
import { parseIpAddress } from '@owlat/shared/ipAddress';

export interface EhloOverrideRow {
	ip: string;
	hostname: string;
}

export type EhloRowProblem = 'ip' | 'hostname' | null;

export const EHLO_ROW_PROBLEM_KEYS: Record<Exclude<EhloRowProblem, null>, string> = {
	ip: 'components.delivery.ehloOverrides.invalidIp',
	hostname: 'components.delivery.ehloOverrides.invalidHostname',
};

function isBlank(row: EhloOverrideRow): boolean {
	return row.ip.trim() === '' && row.hostname.trim() === '';
}

/** What is wrong with one row, or `null`. A fully blank row is simply unused. */
export function ehloRowProblem(row: EhloOverrideRow): EhloRowProblem {
	if (isBlank(row)) return null;
	if (!parseIpAddress(row.ip.trim())) return 'ip';
	try {
		assertValidOutboundEhloHostname(row.hostname.trim(), 'hostname');
	} catch {
		return 'hostname';
	}
	return null;
}

/**
 * The `EHLO_HOSTNAMES` value for the filled-in rows, or `null` while there is
 * nothing to hand over (no rows yet, or one of them is not valid).
 */
export function ehloHostnamesValue(rows: readonly EhloOverrideRow[]): string | null {
	const used = rows.filter((row) => !isBlank(row));
	if (used.length === 0 || used.some((row) => ehloRowProblem(row) !== null)) return null;
	const map = Object.fromEntries(used.map((row) => [row.ip.trim(), row.hostname.trim()]));
	const raw = JSON.stringify(map);
	try {
		return JSON.stringify(parseCanonicalEhloHostnames(raw));
	} catch {
		// Two spellings of one address with different names.
		return null;
	}
}
