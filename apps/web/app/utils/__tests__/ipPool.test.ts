import { describe, it, expect } from 'vitest';
import { unknownIpPoolWarning } from '../ipPool';

describe('unknownIpPoolWarning', () => {
	const pools = ['transactional', 'campaign'];

	it('warns on a pool name the MTA does not know', () => {
		expect(unknownIpPoolWarning('marketing', pools)).toBe(
			'"marketing" is not a known MTA IP pool. Known pools: transactional, campaign.',
		);
	});

	it('returns null for a known pool', () => {
		expect(unknownIpPoolWarning('transactional', pools)).toBeNull();
		expect(unknownIpPoolWarning('campaign', pools)).toBeNull();
	});

	it('trims surrounding whitespace before comparing', () => {
		expect(unknownIpPoolWarning('  transactional  ', pools)).toBeNull();
	});

	it('returns null for a blank value (the field is optional)', () => {
		expect(unknownIpPoolWarning('', pools)).toBeNull();
		expect(unknownIpPoolWarning('   ', pools)).toBeNull();
	});

	it('returns null while the known-pool list is still loading', () => {
		expect(unknownIpPoolWarning('marketing', undefined)).toBeNull();
		expect(unknownIpPoolWarning('marketing', null)).toBeNull();
	});
});
