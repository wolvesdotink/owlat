import { describe, it, expect } from 'vitest';
import { createTestI18n } from '~/__tests__/i18n';
import { planOwnershipTransfer } from '../useOrganization';

// `planOwnershipTransfer` is module scope, so it throws the message KEY and
// `transferOwnership` resolves it; resolving it here keeps the assertions on
// the English sentence a member actually reads.
const { t } = createTestI18n().global;
const refusalOf = (plan: () => unknown): string => {
	try {
		plan();
	} catch (error) {
		return t((error as Error).message);
	}
	throw new Error('expected the transfer to be refused');
};

const owner = { id: 'm-owner', userId: 'u-owner', role: 'owner' as const };
const admin = { id: 'm-admin', userId: 'u-admin', role: 'admin' as const };
const editor = { id: 'm-editor', userId: 'u-editor', role: 'editor' as const };

describe('planOwnershipTransfer', () => {
	it('promotes the new owner FIRST, then demotes the current owner', () => {
		const steps = planOwnershipTransfer([owner, admin, editor], 'u-owner', 'm-admin');

		// Order is load-bearing: promoting first guarantees the org is never left
		// without an owner, so BetterAuth permits the subsequent demotion.
		expect(steps).toEqual([
			{ memberId: 'm-admin', role: 'owner' },
			{ memberId: 'm-owner', role: 'admin' },
		]);
	});

	it('can hand off to an editor as well as an admin', () => {
		const steps = planOwnershipTransfer([owner, admin, editor], 'u-owner', 'm-editor');
		expect(steps[0]).toEqual({ memberId: 'm-editor', role: 'owner' });
		expect(steps[1]).toEqual({ memberId: 'm-owner', role: 'admin' });
	});

	it('rejects the transfer when the caller is not the current owner', () => {
		expect(refusalOf(() => planOwnershipTransfer([owner, admin], 'u-admin', 'm-editor'))).toMatch(
			/only the current owner/i
		);
	});

	it('rejects the transfer when the caller is unknown / unauthenticated', () => {
		expect(refusalOf(() => planOwnershipTransfer([owner, admin], null, 'm-admin'))).toMatch(
			/only the current owner/i
		);
		expect(refusalOf(() => planOwnershipTransfer([owner, admin], undefined, 'm-admin'))).toMatch(
			/only the current owner/i
		);
	});

	it('rejects a no-op transfer to the current owner', () => {
		expect(refusalOf(() => planOwnershipTransfer([owner, admin], 'u-owner', 'm-owner'))).toMatch(
			/already the owner/i
		);
	});
});
