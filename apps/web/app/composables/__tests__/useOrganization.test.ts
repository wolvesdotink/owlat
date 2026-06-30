import { describe, it, expect } from 'vitest';
import { planOwnershipTransfer } from '../useOrganization';

const owner = { id: 'm-owner', userId: 'u-owner', role: 'owner' as const };
const admin = { id: 'm-admin', userId: 'u-admin', role: 'admin' as const };
const editor = { id: 'm-editor', userId: 'u-editor', role: 'editor' as const };

describe('planOwnershipTransfer', () => {
	it('promotes the new owner FIRST, then demotes the current owner', () => {
		const steps = planOwnershipTransfer(
			[owner, admin, editor],
			'u-owner',
			'm-admin',
		);

		// Order is load-bearing: promoting first guarantees the org is never left
		// without an owner, so BetterAuth permits the subsequent demotion.
		expect(steps).toEqual([
			{ memberId: 'm-admin', role: 'owner' },
			{ memberId: 'm-owner', role: 'admin' },
		]);
	});

	it('can hand off to an editor as well as an admin', () => {
		const steps = planOwnershipTransfer(
			[owner, admin, editor],
			'u-owner',
			'm-editor',
		);
		expect(steps[0]).toEqual({ memberId: 'm-editor', role: 'owner' });
		expect(steps[1]).toEqual({ memberId: 'm-owner', role: 'admin' });
	});

	it('rejects the transfer when the caller is not the current owner', () => {
		expect(() =>
			planOwnershipTransfer([owner, admin], 'u-admin', 'm-editor'),
		).toThrow(/only the current owner/i);
	});

	it('rejects the transfer when the caller is unknown / unauthenticated', () => {
		expect(() =>
			planOwnershipTransfer([owner, admin], null, 'm-admin'),
		).toThrow(/only the current owner/i);
		expect(() =>
			planOwnershipTransfer([owner, admin], undefined, 'm-admin'),
		).toThrow(/only the current owner/i);
	});

	it('rejects a no-op transfer to the current owner', () => {
		expect(() =>
			planOwnershipTransfer([owner, admin], 'u-owner', 'm-owner'),
		).toThrow(/already the owner/i);
	});
});
