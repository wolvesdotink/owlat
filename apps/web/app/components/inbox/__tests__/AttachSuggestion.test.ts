// @vitest-environment happy-dom
/**
 * AttachSuggestion review-gate chip:
 *   - a single confident suggestion renders one "Attach <file>" button and emits
 *     `attach` with that candidate on tap (the one-tap attach in the review gate)
 *   - an ambiguous match renders a pick-one button per candidate and emits the
 *     chosen one (the agent never guesses which file — the human confirms)
 *
 * <Icon> is a global auto-import, stubbed here.
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';

import AttachSuggestion from '../AttachSuggestion.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// Every visible string flows through vue-i18n now: mount with the real catalog
// and expose `useI18n`, which is a Nuxt auto-import in the app.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const mountOpts = {
	global: { plugins: [createTestI18n()], stubs: { Icon: true } },
};

function candidate(id: string, over: Record<string, unknown> = {}) {
	return {
		fileId: id,
		storageId: `store_${id}`,
		filename: `${id}.pdf`,
		title: `Title ${id}`,
		mimeType: 'application/pdf',
		fileSize: 100,
		score: 0.9,
		...over,
	};
}

describe('AttachSuggestion', () => {
	it('renders a single one-tap attach and emits the candidate on click', async () => {
		const only = candidate('contract');
		const wrapper = mount(AttachSuggestion, {
			...mountOpts,
			props: { suggestions: { query: 'contract', ambiguous: false, candidates: [only] } },
		});

		const buttons = wrapper.findAll('[data-testid="attach-suggestion"]');
		expect(buttons).toHaveLength(1);
		// Shows a human title over the raw filename.
		expect(wrapper.text()).toContain('Title contract');

		await buttons[0]!.trigger('click');
		const emitted = wrapper.emitted('attach');
		expect(emitted).toBeTruthy();
		expect((emitted![0]![0] as { fileId: string }).fileId).toBe('contract');
	});

	it('renders a pick-one per candidate when the match is ambiguous', async () => {
		const a = candidate('a');
		const b = candidate('b');
		const c = candidate('c');
		const wrapper = mount(AttachSuggestion, {
			...mountOpts,
			props: { suggestions: { query: 'report', ambiguous: true, candidates: [a, b, c] } },
		});

		const buttons = wrapper.findAll('[data-testid="attach-suggestion"]');
		expect(buttons).toHaveLength(3);
		expect(wrapper.text()).toMatch(/pick one/i);

		// Tapping the second choice emits exactly that candidate.
		await buttons[1]!.trigger('click');
		const emitted = wrapper.emitted('attach');
		expect(emitted).toBeTruthy();
		expect((emitted![0]![0] as { fileId: string }).fileId).toBe('b');
	});

	it('falls back to the filename when a candidate has no title', () => {
		const noTitle = candidate('plain', { title: undefined });
		const wrapper = mount(AttachSuggestion, {
			...mountOpts,
			props: { suggestions: { query: 'x', ambiguous: false, candidates: [noTitle] } },
		});
		expect(wrapper.text()).toContain('plain.pdf');
	});
});
