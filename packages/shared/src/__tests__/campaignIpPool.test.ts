import { describe, expect, it } from 'vitest';
import { campaignSendingIps } from '../campaignIpPool';

const pools = { campaign: ['198.51.100.1', '198.51.100.2'], transactional: ['198.51.100.9'] };

describe('campaignSendingIps', () => {
	it('uses the active campaign-pool IPs', () => {
		expect(campaignSendingIps(pools, (ip) => ip !== '198.51.100.1')).toEqual({
			ips: ['198.51.100.2'],
			isBorrowed: false,
		});
	});

	it('borrows the active transactional IPs when no campaign IP is active', () => {
		expect(campaignSendingIps(pools, (ip) => ip === '198.51.100.9')).toEqual({
			ips: ['198.51.100.9'],
			isBorrowed: true,
		});
	});

	it('has nothing to send from when no IP of either pool is active', () => {
		expect(campaignSendingIps(pools, () => false)).toEqual({ ips: [], isBorrowed: true });
	});
});
