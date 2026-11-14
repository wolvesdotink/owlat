/**
 * Doctor's reading of the MTA's egress-address check: whether receivers see
 * each sending IP's mail arrive from that IP.
 *
 * Additive: an MTA that predates the check, or a check that could not observe
 * the address (`unverified`), prints nothing. Only a confirmed mismatch fails,
 * because only that one makes the MTA hold the IP.
 */

import { isRecord } from '@owlat/shared';
import type { DoctorFinding } from '../lib/doctorReport';
import { doctorText } from '../lib/doctorText';

export function evaluateEgressAddress(value: unknown): DoctorFinding[] {
	if (!isRecord(value) || !Array.isArray(value['ips'])) return [];
	const findings: DoctorFinding[] = [];
	for (const item of value['ips']) {
		if (!isRecord(item) || typeof item['ip'] !== 'string') continue;
		const egress = isRecord(item['egressAddress']) ? item['egressAddress'] : null;
		const held =
			Array.isArray(item['blockReasons']) && item['blockReasons'].includes('egress-address');
		const observed =
			egress && typeof egress['observed'] === 'string' ? egress['observed'] : 'another address';
		if (egress?.['verdict'] === 'fail' || held) {
			findings.push({
				check: 'mta.egress_address',
				subject: item['ip'],
				ok: false,
				message: doctorText`Receivers see mail from ${item['ip']} arrive from ${observed}, so the MTA holds ${item['ip']} — make ${item['ip']} this host's outbound address (the source of its default route), or set IP_POOLS_TRANSACTIONAL and IP_POOLS_CAMPAIGN to ${observed}`,
			});
		} else if (egress?.['verdict'] === 'pass') {
			findings.push({
				check: 'mta.egress_address',
				subject: item['ip'],
				ok: true,
				message: doctorText`Receivers see mail from ${item['ip']} arrive from ${item['ip']}`,
			});
		}
	}
	return findings;
}
