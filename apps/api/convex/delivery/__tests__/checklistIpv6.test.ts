import { describe, expect, it } from 'vitest';
import { DELIVERABILITY_CHECKLIST } from '@owlat/shared';
import { ipv6SendingAddresses, isIpv6CheckId, partitionIpv6Items } from '../checklistIpv6';

const ITEMS = DELIVERABILITY_CHECKLIST.map((definition) => ({ id: definition.id }));
const IPV6_IDS = [
	'deployment.ipv6_address',
	'deployment.ipv6_source',
	'deployment.ipv6_ptr',
	'deployment.ipv6_aaaa',
	'deployment.ipv6_spf',
	'deployment.ipv6_pool',
];

describe('ipv6SendingAddresses', () => {
	it('reads only IPv6 entries from the reported pools', () => {
		expect(
			ipv6SendingAddresses({ ips: [{ ip: '203.0.113.25' }, { ip: '2001:db8:4f2::25' }] })
		).toEqual(['2001:db8:4f2::25']);
	});

	it('treats a deployment with no warming snapshot as IPv6 off', () => {
		expect(ipv6SendingAddresses(null)).toEqual([]);
		expect(ipv6SendingAddresses({ ips: [{ ip: '203.0.113.25' }] })).toEqual([]);
	});
});

describe('partitionIpv6Items', () => {
	it('names exactly the six IPv6 checks', () => {
		expect(ITEMS.filter((item) => isIpv6CheckId(item.id)).map((item) => item.id)).toEqual(IPV6_IDS);
	});

	it('drops the IPv6 checks from grading while IPv6 is off', () => {
		const { graded, ipv6 } = partitionIpv6Items(ITEMS, false);
		expect(ipv6).toEqual([]);
		expect(graded.some((item) => IPV6_IDS.includes(item.id))).toBe(false);
		expect(graded).toHaveLength(ITEMS.length - IPV6_IDS.length);
	});

	it('grades every check once IPv6 is on and hands the IPv6 ones back for their group', () => {
		const { graded, ipv6 } = partitionIpv6Items(ITEMS, true);
		expect(graded).toHaveLength(ITEMS.length);
		expect(ipv6.map((item) => item.id)).toEqual(IPV6_IDS);
	});
});
