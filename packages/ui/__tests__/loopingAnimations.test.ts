/**
 * The three looping decorations (indeterminate progress sweep, skeleton
 * shimmer, presence halo) run only while they can be seen, and the determinate
 * progress fill moves without touching layout.
 *
 * What the browser does with the CSS (stepped timing, the paused fallback,
 * reduced motion) is asserted in the stylesheet itself at the bottom; the
 * component half is that each loop registers the right element with the shared
 * observer, follows its on-screen state, and lets go of it on unmount.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick, type Component } from 'vue';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ProgressBar from '../components/ui/ProgressBar.vue';
import Skeleton from '../components/ui/Skeleton.vue';
import PresenceRing from '../components/ui/PresenceRing.vue';
import { ANIMATION_STATE_PROPERTY } from '../utils/visibleAnimation';
import { createUiI18n } from './i18n';
import {
	FakeIntersectionObserver,
	installFakeIntersectionObserver,
} from './fakeIntersectionObserver';

const mounted: VueWrapper[] = [];

function mountUi(component: Component, props: Record<string, unknown> = {}, slot?: string) {
	const wrapper = mount(component, {
		props,
		slots: slot ? { default: slot } : undefined,
		global: { plugins: [createUiI18n()] },
		attachTo: document.body,
	});
	mounted.push(wrapper);
	return wrapper;
}

const stateOf = (el: Element) =>
	(el as HTMLElement).style.getPropertyValue(ANIMATION_STATE_PROPERTY);

beforeEach(() => {
	installFakeIntersectionObserver();
});

afterEach(() => {
	while (mounted.length) mounted.pop()!.unmount();
	document.body.innerHTML = '';
});

describe('UiProgressBar', () => {
	const fillOf = (wrapper: VueWrapper) => wrapper.get('[role="progressbar"] > div');

	it.each([
		[0, '0'],
		[42.4, '42'],
		[100, '100'],
		[180, '100'],
	])('slides a full-width fill to %s%% without a width', (value, expected) => {
		const wrapper = mountUi(ProgressBar, { value, ariaLabel: 'Upload' });
		const fill = fillOf(wrapper);
		expect(fill.classes()).toContain('ui-meter-fill');
		expect(fill.attributes('style') ?? '').not.toMatch(/(^|;)\s*width/);
		expect((fill.element as HTMLElement).style.getPropertyValue('--ui-meter-value')).toBe(expected);
		expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe(expected);
	});

	it('transitions the transform only, never every property', () => {
		const fill = fillOf(mountUi(ProgressBar, { value: 30 }));
		expect(fill.classes()).toContain('transition-transform');
		expect(fill.classes().some((c) => c.startsWith('transition-all') || c.includes('width'))).toBe(
			false
		);
	});

	it('runs the indeterminate sweep only while it is on screen', async () => {
		const wrapper = mountUi(ProgressBar, { indeterminate: true });
		await nextTick();
		const sweep = wrapper.get('.progress-indeterminate').element;
		const observer = FakeIntersectionObserver.current();
		expect(observer.observed.has(sweep)).toBe(true);
		expect(stateOf(sweep)).toBe('paused');

		observer.report(sweep, true);
		expect(stateOf(sweep)).toBe('running');
		observer.report(sweep, false);
		expect(stateOf(sweep)).toBe('paused');
	});

	it('keeps the indeterminate ARIA contract and drops the observer when it turns determinate', async () => {
		const wrapper = mountUi(ProgressBar, { indeterminate: true });
		await nextTick();
		const bar = wrapper.get('[role="progressbar"]');
		expect(bar.attributes('aria-valuenow')).toBeUndefined();
		expect(bar.attributes('aria-valuetext')).toBe('Loading…');
		const observer = FakeIntersectionObserver.current();

		await wrapper.setProps({ indeterminate: false, value: 60 });
		await nextTick();
		expect(observer.disconnected).toBe(true);
		expect(bar.attributes('aria-valuenow')).toBe('60');
	});

	it('does not register a determinate bar at all', async () => {
		mountUi(ProgressBar, { value: 50 });
		await nextTick();
		expect(FakeIntersectionObserver.instances).toHaveLength(0);
	});
});

describe('UiSkeleton', () => {
	it('shares one observer across a page of placeholders and releases it on unmount', async () => {
		const blocks = [mountUi(Skeleton), mountUi(Skeleton), mountUi(Skeleton, { circle: true })];
		await nextTick();
		const observer = FakeIntersectionObserver.current();
		expect(observer.observed.size).toBe(3);

		observer.report(blocks[0]!.element, true);
		expect(stateOf(blocks[0]!.element)).toBe('running');
		expect(stateOf(blocks[1]!.element)).toBe('paused');

		for (const block of mounted.splice(0)) block.unmount();
		expect(observer.disconnected).toBe(true);
	});
});

describe('UiPresenceRing', () => {
	it('draws the halo and registers it while the person is present', async () => {
		const wrapper = mountUi(PresenceRing, {}, '<span class="avatar">A</span>');
		await nextTick();
		expect(wrapper.classes()).toContain('ui-presence-ring');
		expect(wrapper.find('.avatar').exists()).toBe(true);
		const observer = FakeIntersectionObserver.current();
		expect(observer.observed.has(wrapper.element)).toBe(true);
		observer.report(wrapper.element, true);
		expect(stateOf(wrapper.element)).toBe('running');
	});

	it('keeps the same avatar element and drops the halo when presence ends', async () => {
		const wrapper = mountUi(PresenceRing, { active: true }, '<span class="avatar">A</span>');
		await nextTick();
		const avatar = wrapper.get('.avatar').element;
		const observer = FakeIntersectionObserver.current();

		await wrapper.setProps({ active: false });
		await nextTick();
		expect(wrapper.classes()).not.toContain('ui-presence-ring');
		expect(wrapper.get('.avatar').element).toBe(avatar);
		expect(observer.disconnected).toBe(true);
		expect(stateOf(wrapper.element)).toBe('paused');

		await wrapper.setProps({ active: true });
		await nextTick();
		expect(wrapper.classes()).toContain('ui-presence-ring');
		expect(FakeIntersectionObserver.current().observed.has(wrapper.element)).toBe(true);
	});

	it('passes attributes such as a title through to the wrapper', () => {
		const wrapper = mountUi(PresenceRing, { title: 'Ada is viewing' });
		expect(wrapper.attributes('title')).toBe('Ada is viewing');
	});
});

/**
 * The CSS half of the contract. happy-dom does not run animations, so the
 * declarations themselves are the oracle: what loops reads the shared state
 * with a paused fallback, steps instead of repainting every frame, animates a
 * compositor-only property, and has a static reduced-motion fallback.
 */
describe('looping animation stylesheets', () => {
	const root = join(dirname(fileURLToPath(import.meta.url)), '..');
	const read = (path: string) => readFileSync(join(root, path), 'utf8');
	const loops = [
		{ file: 'assets/css/motion.css', rule: '.ui-presence-ring::after', property: 'opacity' },
		{ file: 'components/ui/Skeleton.vue', rule: '.ui-skeleton::after', property: 'transform' },
		{
			file: 'components/ui/ProgressBar.vue',
			rule: '.progress-indeterminate',
			property: 'transform',
		},
	];

	/** The body of the first top-level `selector { ... }` block. */
	const ruleBody = (css: string, selector: string): string => {
		const start = css.indexOf(`${selector} {`);
		expect(start, `${selector} not found`).toBeGreaterThan(-1);
		return css.slice(start, css.indexOf('}', start));
	};

	it.each(loops)('$rule pauses unless registered and steps its frames', ({ file, rule }) => {
		const body = ruleBody(read(file), rule);
		expect(body).toMatch(/animation:[^;]*\bsteps\(\d+\)[^;]*\binfinite\b/);
		expect(body).toContain('animation-play-state: var(--ui-animation-state, paused);');
	});

	it.each(loops)('$rule keyframes animate $property only', ({ file, property }) => {
		const css = read(file);
		const name = /animation:\s*([\w-]+)/.exec(
			ruleBody(css, loops.find((l) => l.file === file)!.rule)
		)![1]!;
		const start = css.indexOf(`@keyframes ${name}`);
		expect(start).toBeGreaterThan(-1);
		const keyframes = css.slice(start, css.indexOf('\n}', start));
		const animated = [...keyframes.matchAll(/([a-z-]+):/g)].map((m) => m[1]);
		expect(new Set(animated)).toEqual(new Set([property]));
	});

	it.each(loops)('$rule stops entirely under reduced motion', ({ file, rule }) => {
		const css = read(file);
		const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
		expect(ruleBody(reduced, rule)).toContain('animation: none;');
	});
});
