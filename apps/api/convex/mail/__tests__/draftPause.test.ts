/**
 * How the unused-draft streak moves (mail/draftPause.ts): an unused
 * draft counts, the fifth pauses, a used one resets (also while paused), and
 * nothing counts up while paused.
 */

import { describe, expect, it } from 'vitest';
import { nextDraftPause, UNUSED_DRAFT_PAUSE_AT } from '../draftPause';

describe('nextDraftPause', () => {
	it('counts an unused draft without logging it', () => {
		expect(nextDraftPause({ unusedDraftStreak: 1 }, 'unused', 5)).toEqual({
			after: { unusedDraftStreak: 2 },
			isLogged: false,
		});
	});

	it(`pauses at ${UNUSED_DRAFT_PAUSE_AT}, logged`, () => {
		expect(nextDraftPause({ unusedDraftStreak: 4 }, 'unused', 7)).toEqual({
			after: { autoDraftPausedAt: 7, unusedDraftStreak: 5 },
			isLogged: true,
		});
	});

	it('resets on a used draft, logged, and does nothing at 0', () => {
		expect(nextDraftPause({ unusedDraftStreak: 3 }, 'used', 7)).toEqual({
			after: { unusedDraftStreak: 0 },
			isLogged: true,
		});
		expect(nextDraftPause({ unusedDraftStreak: 0 }, 'used', 7)).toBeNull();
	});

	it('resets while paused, keeping the pause, and counts nothing more', () => {
		const paused = { autoDraftPausedAt: 1, unusedDraftStreak: 5 };
		expect(nextDraftPause(paused, 'used', 7)).toEqual({
			after: { autoDraftPausedAt: 1, unusedDraftStreak: 0 },
			isLogged: true,
		});
		expect(nextDraftPause(paused, 'unused', 7)).toBeNull();
	});
});
