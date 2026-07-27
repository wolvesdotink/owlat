// @vitest-environment happy-dom
/**
 * The DNS propagation note — a real mount of the block extracted out of
 * `RecordRow.vue`.
 *
 * The extraction is only safe if the markup it carries is pinned, so this
 * asserts the three things an operator actually depends on: the propagation
 * expectation, the next action they are told to take, and a docs link that is
 * safe to open in a new tab (`rel="noopener noreferrer"`, which is easy to lose
 * in a refactor and impossible to notice by eye).
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import DnsPropagationNote from '../DnsPropagationNote.vue';

const stubs = { Icon: { props: ['name'], template: '<i :data-icon="name" />' } };

function mountNote() {
	return mount(DnsPropagationNote, { global: { stubs } });
}

describe('DnsPropagationNote', () => {
	it('states the propagation delay and the next action', () => {
		const text = mountNote().text();
		expect(text).toContain('up to 48 hours');
		expect(text).toContain('Verify Domain');
	});

	it('links to the DNS docs and opens it safely in a new tab', () => {
		const link = mountNote().get('a');
		expect(link.attributes('href')).toBe('https://docs.owlat.app/developer/self-hosting-dns-email');
		expect(link.attributes('target')).toBe('_blank');
		// Both tokens, not just `noopener`: a stray `noreferrer`-only or
		// `noopener`-only value is the regression this pins.
		expect(link.attributes('rel')).toBe('noopener noreferrer');
		expect(link.text()).toContain('Learn more');
	});

	it('renders nothing that depends on the row it was extracted from', () => {
		// No props, no injected state — mounting bare must not warn or throw,
		// which is what makes the `v-if` at the call site the ONLY gate.
		expect(mountNote().find('div').exists()).toBe(true);
	});
});
