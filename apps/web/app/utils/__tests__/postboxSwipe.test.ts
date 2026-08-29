/**
 * The swipe-to-triage gesture math (UX plan idea 21).
 *
 * These are the decisions that make the gesture safe: what counts as a
 * horizontal drag rather than a scroll, how far is far enough to fire a triage
 * verb, and when a flick is allowed to stand in for the distance. All of it is
 * pure, so it is pinned here rather than through a mounted, Convex-backed list.
 */
import { describe, expect, it } from 'vitest';
import {
	classifySwipeIntent,
	isSwipePointer,
	POSTBOX_SWIPE_ACTION_OPTIONS,
	POSTBOX_SWIPE_COMMIT_PX,
	POSTBOX_SWIPE_FLING_PX,
	POSTBOX_SWIPE_FLING_VELOCITY,
	POSTBOX_SWIPE_LEFT_DEFAULT,
	POSTBOX_SWIPE_MAX_PX,
	POSTBOX_SWIPE_RIGHT_DEFAULT,
	POSTBOX_SWIPE_SETTLE_MS,
	POSTBOX_SWIPE_SLOP_PX,
	POSTBOX_SWIPE_VISUALS,
	pruneSwipeSamples,
	resolvePostboxSwipeAction,
	resolveSwipeRelease,
	swipeActionFor,
	swipeDirection,
	swipeProgress,
	swipeSettleMs,
	swipeTrackState,
	swipeTranslation,
	swipeVelocity,
	type PostboxSwipeAction,
} from '../postboxSwipe';

describe('resolvePostboxSwipeAction', () => {
	it('defaults an unset preference to the direction it belongs to', () => {
		expect(resolvePostboxSwipeAction(undefined, POSTBOX_SWIPE_LEFT_DEFAULT)).toBe('archive');
		expect(resolvePostboxSwipeAction(null, POSTBOX_SWIPE_RIGHT_DEFAULT)).toBe('snooze');
	});

	it('keeps every action the picker offers', () => {
		for (const option of POSTBOX_SWIPE_ACTION_OPTIONS) {
			expect(resolvePostboxSwipeAction(option.value, 'archive')).toBe(option.value);
		}
	});

	it('falls back rather than trusting an unknown stored value', () => {
		expect(resolvePostboxSwipeAction('delete-everything', 'snooze')).toBe('snooze');
	});

	it('gives every non-none action a track icon and tone', () => {
		for (const option of POSTBOX_SWIPE_ACTION_OPTIONS) {
			if (option.value === 'none') continue;
			const visual = POSTBOX_SWIPE_VISUALS[option.value];
			expect(visual.icon).toMatch(/^lucide:/);
			expect(visual.tone).not.toBe('');
		}
	});
});

describe('classifySwipeIntent — scrolling wins ties', () => {
	it('claims nothing inside the slop', () => {
		expect(classifySwipeIntent(POSTBOX_SWIPE_SLOP_PX, 0)).toBe('pending');
		expect(classifySwipeIntent(-4, 3)).toBe('pending');
	});

	it('claims a clearly sideways drag', () => {
		expect(classifySwipeIntent(30, 4)).toBe('horizontal');
		expect(classifySwipeIntent(-40, -10)).toBe('horizontal');
	});

	it('abandons a vertical drag — the list has to keep scrolling', () => {
		expect(classifySwipeIntent(2, 40)).toBe('abandoned');
		expect(classifySwipeIntent(0, -25)).toBe('abandoned');
	});

	it('abandons a 45-degree diagonal instead of hijacking it', () => {
		expect(classifySwipeIntent(30, 30)).toBe('abandoned');
		expect(classifySwipeIntent(20, 15)).toBe('abandoned');
	});
});

describe('swipeDirection / swipeActionFor', () => {
	it('maps the sign of the displacement to a side', () => {
		expect(swipeDirection(-1)).toBe('left');
		expect(swipeDirection(1)).toBe('right');
		expect(swipeDirection(0)).toBeNull();
	});

	it('reads the remapped action for the side the finger went', () => {
		expect(swipeActionFor(-100, 'trash', 'star')).toBe('trash');
		expect(swipeActionFor(100, 'trash', 'star')).toBe('star');
	});

	it('is inert on a direction mapped to none', () => {
		expect(swipeActionFor(-100, 'none', 'snooze')).toBeNull();
		expect(swipeActionFor(100, 'archive', 'none')).toBeNull();
	});
});

describe('swipeTranslation — the row resists past the commit point', () => {
	it('follows the finger one-to-one up to the threshold', () => {
		expect(swipeTranslation(0)).toBe(0);
		expect(swipeTranslation(-40)).toBe(-40);
		expect(swipeTranslation(POSTBOX_SWIPE_COMMIT_PX)).toBe(POSTBOX_SWIPE_COMMIT_PX);
	});

	it('rubber-bands towards the ceiling without ever reaching it', () => {
		const far = swipeTranslation(400);
		expect(far).toBeGreaterThan(POSTBOX_SWIPE_COMMIT_PX);
		expect(far).toBeLessThan(POSTBOX_SWIPE_MAX_PX);
		expect(swipeTranslation(10_000)).toBeLessThan(POSTBOX_SWIPE_MAX_PX);
	});

	it('stays monotone and symmetric', () => {
		expect(swipeTranslation(200)).toBeGreaterThan(swipeTranslation(120));
		expect(swipeTranslation(-200)).toBe(-swipeTranslation(200));
	});
});

describe('swipeProgress / swipeTrackState', () => {
	it('reports progress towards the commit distance, clamped', () => {
		expect(swipeProgress(0)).toBe(0);
		expect(swipeProgress(POSTBOX_SWIPE_COMMIT_PX / 2)).toBeCloseTo(0.5);
		expect(swipeProgress(-999)).toBe(1);
	});

	it('describes the reveal track for a half-finished drag', () => {
		const track = swipeTrackState({ dx: -44, leftAction: 'archive', rightAction: 'snooze' });
		expect(track).toMatchObject({
			action: 'archive',
			direction: 'left',
			armed: false,
			icon: POSTBOX_SWIPE_VISUALS.archive.icon,
		});
		expect(track?.progress).toBeCloseTo(0.5);
		expect(track?.offsetPx).toBe(-44);
	});

	it('arms exactly at the commit distance', () => {
		const armed = swipeTrackState({
			dx: POSTBOX_SWIPE_COMMIT_PX,
			leftAction: 'archive',
			rightAction: 'snooze',
		});
		expect(armed?.armed).toBe(true);
		expect(armed?.action).toBe('snooze');
	});

	it('shows nothing at rest, and nothing on an inert direction', () => {
		expect(swipeTrackState({ dx: 0, leftAction: 'archive', rightAction: 'snooze' })).toBeNull();
		expect(swipeTrackState({ dx: -80, leftAction: 'none', rightAction: 'snooze' })).toBeNull();
	});
});

describe('resolveSwipeRelease — distance or a deliberate flick', () => {
	const mapping = { leftAction: 'archive' as PostboxSwipeAction, rightAction: 'snooze' as const };

	it('commits once the drag passed the threshold, however slowly', () => {
		expect(resolveSwipeRelease({ dx: -POSTBOX_SWIPE_COMMIT_PX, velocityX: 0, ...mapping })).toBe(
			'archive'
		);
		expect(resolveSwipeRelease({ dx: 150, velocityX: 0, ...mapping })).toBe('snooze');
	});

	it('springs back from a short, slow drag', () => {
		expect(resolveSwipeRelease({ dx: -50, velocityX: -0.1, ...mapping })).toBeNull();
	});

	it('commits a short but fast flick', () => {
		expect(
			resolveSwipeRelease({
				dx: -(POSTBOX_SWIPE_FLING_PX + 1),
				velocityX: -(POSTBOX_SWIPE_FLING_VELOCITY + 0.1),
				...mapping,
			})
		).toBe('archive');
	});

	it('refuses a fast flick that has barely moved', () => {
		expect(resolveSwipeRelease({ dx: -8, velocityX: -2, ...mapping })).toBeNull();
	});

	it('refuses a flick that reversed — the finger took it back', () => {
		expect(
			resolveSwipeRelease({ dx: -(POSTBOX_SWIPE_FLING_PX + 10), velocityX: 2, ...mapping })
		).toBeNull();
	});

	it('never fires a direction mapped to none, however hard it is thrown', () => {
		expect(
			resolveSwipeRelease({ dx: -300, velocityX: -5, leftAction: 'none', rightAction: 'snooze' })
		).toBeNull();
	});
});

describe('swipeVelocity', () => {
	it('is zero without two samples to compare', () => {
		expect(swipeVelocity([])).toBe(0);
		expect(swipeVelocity([{ x: 10, t: 1 }])).toBe(0);
	});

	it('measures over the window, not the last two events', () => {
		// 60px over 100ms, delivered in 5ms steps: a two-sample estimate would
		// read the last 3px/5ms jitter, this reads the gesture.
		const samples = Array.from({ length: 21 }, (_, i) => ({ x: i * 3, t: i * 5 }));
		expect(swipeVelocity(samples)).toBeCloseTo(0.6, 5);
	});

	it('is signed, so a leftward flick reads negative', () => {
		expect(
			swipeVelocity([
				{ x: 0, t: 0 },
				{ x: -50, t: 100 },
			])
		).toBeCloseTo(-0.5);
	});

	it('reports zero rather than dividing by a zero interval', () => {
		expect(
			swipeVelocity([
				{ x: 0, t: 7 },
				{ x: 40, t: 7 },
			])
		).toBe(0);
	});

	it('drops samples that aged out of the window', () => {
		const kept = pruneSwipeSamples(
			[
				{ x: 0, t: 0 },
				{ x: 10, t: 900 },
				{ x: 20, t: 980 },
			],
			1000,
			120
		);
		expect(kept.map((sample) => sample.t)).toEqual([900, 980]);
	});
});

describe('reduced motion and pointer types', () => {
	it('drops the settle animation for a reduced-motion viewer', () => {
		expect(swipeSettleMs(false)).toBe(POSTBOX_SWIPE_SETTLE_MS);
		expect(swipeSettleMs(true)).toBe(0);
	});

	it('is touch and pen only — a mouse drag must never triage', () => {
		expect(isSwipePointer('touch')).toBe(true);
		expect(isSwipePointer('pen')).toBe(true);
		expect(isSwipePointer('mouse')).toBe(false);
		expect(isSwipePointer('')).toBe(false);
	});
});
