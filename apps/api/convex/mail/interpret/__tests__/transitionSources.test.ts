/** Resetting what a purged source set (mail/interpret/transitionSources.ts). */

import { describe, expect, it } from 'vitest';
import { resetTransitionsFrom } from '../transitionSources';

const item = {
	status: 'done' as const,
	completion: 'reported' as const,
	disposition: 'answered' as const,
	statusSource: { sourceKey: 'mail:m2', at: 200 },
	dispositionSource: { sourceKey: 'mail:m1', at: 100 },
};

describe('resetTransitionsFrom', () => {
	it('resets the status the purged message set, keeps the disposition another one set', () => {
		expect(resetTransitionsFrom(item, 'mail:m2')).toEqual({
			status: 'open',
			completion: undefined,
			statusSource: undefined,
			lastTransitionAt: 100,
			isReviewNeeded: true,
		});
	});

	it('resets the disposition only', () => {
		expect(resetTransitionsFrom(item, 'mail:m1')).toEqual({
			disposition: 'unanswered',
			dispositionSource: undefined,
			lastTransitionAt: 200,
			isReviewNeeded: true,
		});
	});

	it('leaves what a person set, and items the source never touched', () => {
		const human = { ...item, statusSource: { sourceKey: 'user:u1', at: 300 } };
		expect(resetTransitionsFrom(human, 'mail:m2')).toBeNull();
		expect(resetTransitionsFrom(item, 'mail:m9')).toBeNull();
	});
});
