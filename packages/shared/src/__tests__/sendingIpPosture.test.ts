import { describe, expect, it } from 'vitest';
import { isSendingIpHeld, sendingIpPosture } from '../ipReadiness';

describe('sendingIpPosture', () => {
	it('is null before any address is synced', () => {
		expect(sendingIpPosture([], 'campaign')).toBeNull();
	});

	it('judges only the pool asked for', () => {
		const ips = [
			{ pool: 'campaign', active: true, blockReasons: ['dnsbl' as const] },
			{ pool: 'transactional', active: true },
		];
		expect(sendingIpPosture(ips, 'campaign')).toBe('all_held');
		expect(sendingIpPosture(ips, 'transactional')).toBe('ready');
	});

	it('falls back to every address when the pool lists none', () => {
		const ips = [
			{ pool: 'default', active: true },
			{ pool: 'default', active: false },
		];
		expect(sendingIpPosture(ips, 'transactional')).toBe('some_held');
	});

	it('holds an address out of rotation or with a block reason', () => {
		expect(isSendingIpHeld({ pool: 'campaign', active: false })).toBe(true);
		expect(isSendingIpHeld({ pool: 'campaign', active: true, blockReasons: ['spf'] })).toBe(true);
		expect(isSendingIpHeld({ pool: 'campaign', active: true, blockReasons: [] })).toBe(false);
	});
});
