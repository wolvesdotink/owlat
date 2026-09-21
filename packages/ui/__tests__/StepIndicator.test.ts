// @vitest-environment happy-dom
/**
 * A WIZARD RAIL SPENDS ONE ACCENT, NOT SIX.
 *
 * DESIGN-LANGUAGE.md rule 1 puts terracotta in *small* quantities and §5 names
 * "terracotta used as a large fill" as the first smell to hunt. The step rail
 * used to break that everywhere at once: completed discs were `bg-brand`, the
 * current disc was `bg-brand/20 … border-2 border-brand`, completed labels were
 * `text-brand` and every passed connector was `bg-brand/30` — on a five-step
 * setup wizard that is up to nine terracotta elements in one 40px-tall strip.
 *
 * Class-level assertions, like PageHeader's: the component ships almost no
 * behaviour, so the recipe IS the contract, and the whole point of the sweep is
 * that a later edit cannot quietly put the fills back.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import StepIndicator from '../components/ui/StepIndicator.vue';

const STEPS = [
	{ id: 'mode', label: 'Mode', number: 1 },
	{ id: 'features', label: 'Features', number: 2 },
	{ id: 'review', label: 'Review', number: 3 },
];

/** Step 1 done, step 2 current, step 3 upcoming — the interesting middle. */
function mountRail() {
	return mount(StepIndicator, {
		props: {
			steps: STEPS,
			getStepStatus: (id: string) =>
				id === 'mode' ? 'completed' : id === 'features' ? 'current' : 'upcoming',
			isConnectorHighlighted: (index: number) => index === 0,
		},
		global: { stubs: { Icon: true } },
	});
}

/** The 32px discs, in step order. */
const discs = (w: ReturnType<typeof mountRail>) => w.findAll('.rounded-full');

describe('StepIndicator — one accent', () => {
	it('fills the completed step monochrome, the same logic as .btn-primary', () => {
		const completed = discs(mountRail())[0];

		expect(completed?.classes()).toEqual(
			expect.arrayContaining(['bg-text-primary', 'text-text-inverse'])
		);
		expect(completed?.classes()).not.toContain('bg-brand');
	});

	it('marks the current step with a ring, not a brand-tinted fill', () => {
		const current = discs(mountRail())[1];

		// The rail's single terracotta element: a 1px ring on the step you are on.
		expect(current?.classes()).toEqual(
			expect.arrayContaining(['ring-1', 'ring-brand', 'bg-bg-surface', 'text-text-primary'])
		);
		expect(current?.classes()).not.toContain('bg-brand/20');
		expect(current?.classes()).not.toContain('border-brand');
	});

	it('draws the passed connector on the text ladder, not on brand', () => {
		const connector = mountRail().findAll('.h-0\\.5');

		expect(connector[0]?.classes()).toContain('bg-text-primary/30');
		expect(connector[1]?.classes()).toContain('bg-border-subtle');
	});

	it('leaves exactly one brand class in the whole rail', () => {
		const w = mountRail();

		const branded = w
			.findAll('*')
			.flatMap((node) => node.classes())
			.filter((name) => name.includes('brand'));

		expect(branded).toEqual(['ring-brand']);
	});
});

/**
 * THE CONNECTORS ARE ONE LENGTH, WHATEVER THE LABELS SAY.
 *
 * With `flex-1` (basis 0) on the li every step got the same total width, so the
 * connector — the only flexible child inside it — kept whatever the label left
 * over: "Mode ——— Features · Email ——— Account - Review", 40px lines beside 6px
 * hyphens. `flex-auto` (basis auto) measures the label first and splits only the
 * leftover, which is what makes every connector equal. Layout is not observable
 * in happy-dom, so the recipe is the contract here too.
 */
describe('StepIndicator — even connectors', () => {
	it('sizes each step to its label and shares only the leftover row', () => {
		const items = mountRail().findAll('li');

		expect(items[0]?.classes()).toContain('flex-auto');
		expect(items[1]?.classes()).toContain('flex-auto');
		// A zero basis is the bug: it hands every li the same width regardless of
		// how long its label is.
		expect(items[0]?.classes()).not.toContain('flex-1');
		// Last step carries no connector, so it must not claim any of the leftover.
		expect(items[2]?.classes()).toContain('shrink-0');
		expect(items[2]?.classes()).not.toContain('flex-auto');
	});
});
