import { describe, expect, it } from 'vitest';
import { loadOutboundIpConfig } from '../outboundIpConfig.js';

function load(transactional: string, campaign: string) {
	const values: Record<string, string> = {
		IP_POOLS_TRANSACTIONAL: transactional,
		IP_POOLS_CAMPAIGN: campaign,
	};
	return loadOutboundIpConfig((key) => values[key]!, { MTA_IPV6_ENABLED: 'true' });
}

describe('loadOutboundIpConfig', () => {
	it('requires an IPv4 fallback inside each pool that contains IPv6', () => {
		expect(() => load('203.0.113.10', '2001:db8::10')).toThrow(/campaign pool.*IPv4 fallback/i);
		expect(() => load('2001:db8::10', '203.0.113.11')).toThrow(
			/transactional pool.*IPv4 fallback/i
		);
		expect(() => load('203.0.113.10,2001:db8::10', '203.0.113.11,2001:db8::11')).not.toThrow();
	});
});
