// @vitest-environment happy-dom
/**
 * The skeleton primitive and its two composites.
 *
 * The bug worth a regression test is the fill: `UiSkeleton` painted itself
 * `bg-bg-elevated`, and `--color-bg-elevated` is `--surface-2` — the exact
 * background `UiCard` paints. Every placeholder inside a card was therefore
 * invisible, which is why ~29 blocks across the app hand-rolled
 * `animate-pulse bg-bg-surface` rather than reach for the component. The first
 * case pins the fill to a class that is a visible step against the card AND the
 * page, so nobody "tidies" it back onto the elevated token.
 *
 * The composites are asserted through UiSkeleton's own props/DOM rather than
 * their markup classes, so a later re-skin of the primitive does not break them.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import Skeleton from '../components/ui/Skeleton.vue';
import SkeletonText from '../components/ui/SkeletonText.vue';
import SkeletonRow from '../components/ui/SkeletonRow.vue';

/** The two ladder steps a card and the page paint themselves with. */
const INVISIBLE_IN_A_CARD = ['bg-bg-elevated', 'bg-surface-2'];

describe('UiSkeleton', () => {
	it('fills with a step that stays visible inside a UiCard', () => {
		const classes = mount(Skeleton).classes();
		expect(classes).toContain('bg-bg-surface');
		for (const banned of INVISIBLE_IN_A_CARD) expect(classes).not.toContain(banned);
	});

	it('is decorative — the loading announcement belongs to the boundary', () => {
		expect(mount(Skeleton).attributes('aria-hidden')).toBe('true');
	});

	it('renders a bar by default and a disc with `circle`', () => {
		expect(mount(Skeleton).classes()).toContain('rounded');
		expect(mount(Skeleton, { props: { circle: true } }).classes()).toContain('rounded-full');
	});
});

describe('UiSkeletonText', () => {
	it('renders one bar per line', () => {
		const w = mount(SkeletonText, { props: { lines: 4 } });
		expect(w.findAllComponents(Skeleton)).toHaveLength(4);
	});

	it('ends on a short line so the block reads as ragged prose', () => {
		const bars = mount(SkeletonText, { props: { lines: 3 } }).findAllComponents(Skeleton);
		expect(bars.slice(0, -1).every((bar) => bar.classes().includes('w-full'))).toBe(true);
		expect(bars.at(-1)!.classes()).toContain('w-2/3');
	});

	it('keeps a single line full width — there is no ragged edge to draw', () => {
		const bars = mount(SkeletonText, { props: { lines: 1 } }).findAllComponents(Skeleton);
		expect(bars).toHaveLength(1);
		expect(bars[0]!.classes()).toContain('w-full');
	});

	it('sizes its lines from the text ladder step it stands in for', () => {
		const heightOf = (size: 'sm' | 'md' | 'lg') =>
			mount(SkeletonText, { props: { lines: 1, size } })
				.findComponent(Skeleton)
				.classes()
				.find((c) => c.startsWith('h-'));
		expect(heightOf('sm')).toBe('h-3');
		expect(heightOf('md')).toBe('h-3.5');
		expect(heightOf('lg')).toBe('h-4');
	});
});

describe('UiSkeletonRow', () => {
	/**
	 * Count discs by UiSkeleton's `circle` contract rather than the
	 * `rounded-full` class, which is the primitive's own implementation detail.
	 */
	const circleCount = (props: Record<string, unknown> = {}) =>
		mount(SkeletonRow, { props })
			.findAllComponents(Skeleton)
			.filter((bar) => bar.props('circle') === true).length;

	it('renders avatar, two text lines and a trailing chip by default', () => {
		expect(mount(SkeletonRow).findAllComponents(Skeleton)).toHaveLength(4);
		expect(circleCount()).toBe(1);
	});

	it('drops the avatar and the trailing chip when asked', () => {
		const props = { avatar: false, trailing: false };
		expect(mount(SkeletonRow, { props }).findAllComponents(Skeleton)).toHaveLength(2);
		expect(circleCount(props)).toBe(0);
	});

	it('renders a single text line for a one-line row', () => {
		const bars = mount(SkeletonRow, {
			props: { avatar: false, trailing: false, lines: 1 },
		}).findAllComponents(Skeleton);
		expect(bars).toHaveLength(1);
	});

	it('is decorative', () => {
		expect(mount(SkeletonRow).attributes('aria-hidden')).toBe('true');
	});
});
