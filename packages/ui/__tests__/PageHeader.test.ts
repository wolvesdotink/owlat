// @vitest-environment happy-dom
/**
 * The header primitive exists to stop the ladder drifting, so the ladder is
 * what this suite pins.
 *
 * Every assertion here is a rule from `docs/ui-review/DESIGN-LANGUAGE.md` that
 * the ~77 hand-rolled headers each broke somewhere: the title is weight 450
 * with −0.02em tracking (never `font-semibold` "shouting"), the eyebrow is the
 * shared `lp-eyebrow` utility rather than a local uppercase span, and the lead
 * is capped at the marketing measure so it wraps as prose on a wide viewport.
 * Class-level assertions are unusual, but they are the contract: this component
 * ships no behaviour, only that recipe, and a silent edit to it re-opens the
 * eight audit findings the rollout closed.
 *
 * The slots are asserted on presence AND absence, because the wrappers are what
 * a page with no buttons would otherwise inherit as an empty flex row.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PageHeader from '../components/ui/PageHeader.vue';

function mountHeader(props: Record<string, unknown>, slots: Record<string, string> = {}) {
	return mount(PageHeader, { props: { title: 'Segments', ...props }, slots });
}

describe('PageHeader', () => {
	it('renders the title as the page h1 at the display recipe', () => {
		const h1 = mountHeader({}).get('h1');
		expect(h1.text()).toBe('Segments');
		// 450 via the overridden font-weight scale, plus the display tracking.
		expect(h1.classes()).toEqual(
			expect.arrayContaining(['font-medium', 'tracking-[-0.02em]', 'text-text-primary'])
		);
		expect(h1.classes()).not.toContain('font-semibold');
	});

	it('renders the eyebrow on the shared landing utility, above the title', () => {
		const w = mountHeader({ eyebrow: 'Audience' });
		const eyebrow = w.get('.lp-eyebrow');
		expect(eyebrow.text()).toBe('Audience');
		expect(eyebrow.element.compareDocumentPosition(w.get('h1').element)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING
		);
	});

	it('omits the eyebrow entirely when the page has no section label', () => {
		expect(mountHeader({}).find('.lp-eyebrow').exists()).toBe(false);
	});

	it('caps the lead at the 540px measure in secondary text', () => {
		const lead = mountHeader({ description: 'Create and manage audience segments.' }).get('p');
		expect(lead.text()).toBe('Create and manage audience segments.');
		expect(lead.classes()).toEqual(
			expect.arrayContaining(['max-w-[540px]', 'text-text-secondary'])
		);
	});

	it('drops the lead paragraph when there is no description', () => {
		expect(mountHeader({}).find('p').exists()).toBe(false);
	});

	it('renders the actions and meta slots when a page supplies them', () => {
		const w = mountHeader(
			{ description: 'Lead' },
			{ actions: '<button>New segment</button>', meta: '<span>128 contacts</span>' }
		);
		expect(w.get('button').text()).toBe('New segment');
		expect(w.text()).toContain('128 contacts');
	});

	it('renders no slot wrappers at all for a header with neither', () => {
		const w = mountHeader({ description: 'Lead' });
		// Root + the text column: no empty action row, no empty meta strip.
		expect(w.element.children).toHaveLength(1);
	});
});
