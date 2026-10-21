import { describe, expect, it } from 'vitest';
import { offersShareWithMembers } from '../knowledgeSharing';

describe('offersShareWithMembers', () => {
	it('offers sharing a restricted entry to owners and admins only', () => {
		expect(offersShareWithMembers({ memberAccess: 'restricted' }, true)).toBe(true);
		expect(offersShareWithMembers({ memberAccess: 'restricted' }, false)).toBe(false);
	});

	it('does not offer it for an entry members can already see, or none', () => {
		expect(offersShareWithMembers({ memberAccess: 'members' }, true)).toBe(false);
		expect(offersShareWithMembers({}, true)).toBe(false);
		expect(offersShareWithMembers(null, true)).toBe(false);
	});
});
