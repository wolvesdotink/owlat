import { describe, expect, it } from 'vitest';
import { sendingIpPosture } from '../ipReadiness';

describe('sendingIpPosture', () => {
	it('is null before any address is synced', () => {
		expect(sendingIpPosture([], 'campaign')).toBeNull();
	});

	it('judges only the pool asked for', () => {
		const ips = [
			{ ip: '192.0.2.1', pool: 'campaign', active: true, blockReasons: ['dnsbl' as const] },
			{ ip: '192.0.2.2', pool: 'transactional', active: true },
		];
		expect(sendingIpPosture(ips, 'campaign')).toBe('all_held');
		expect(sendingIpPosture(ips, 'transactional')).toBe('ready');
	});

	it('reads membership from the pool lists, since a shared row names only its first pool', () => {
		// 192.0.2.1 serves both pools but its row says `transactional`; the held
		// 192.0.2.2 is campaign-only, so campaigns still have a healthy address.
		const ips = [
			{ ip: '192.0.2.1', pool: 'transactional', active: true },
			{ ip: '192.0.2.2', pool: 'campaign', active: true, blockReasons: ['dnsbl' as const] },
		];
		const pools = { transactional: ['192.0.2.1'], campaign: ['192.0.2.1', '192.0.2.2'] };
		expect(sendingIpPosture(ips, 'campaign')).toBe('all_held');
		expect(sendingIpPosture(ips, 'campaign', pools)).toBe('some_held');
		expect(sendingIpPosture(ips, 'transactional', pools)).toBe('ready');
	});

	it('falls back to every address when the pool lists none', () => {
		const ips = [
			{ ip: '192.0.2.1', pool: 'default', active: true },
			{ ip: '192.0.2.2', pool: 'default', active: false },
		];
		expect(sendingIpPosture(ips, 'transactional')).toBe('some_held');
	});

	it('holds an address out of rotation or with a block reason', () => {
		const posture = (ip: { active: boolean; blockReasons?: readonly ['spf'] | readonly [] }) =>
			sendingIpPosture([{ ip: '192.0.2.1', pool: 'campaign', ...ip }], 'campaign');
		expect(posture({ active: false })).toBe('all_held');
		expect(posture({ active: true, blockReasons: ['spf'] })).toBe('all_held');
		expect(posture({ active: true, blockReasons: [] })).toBe('ready');
	});
});
