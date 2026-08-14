import { describe, it, expect, beforeAll } from 'vitest';
import { mount } from '@vue/test-utils';

import PostboxAppPasswordCallout from '../PostboxAppPasswordCallout.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';

// Every visible string flows through vue-i18n now: mount with the real catalog
// and expose `useI18n`, which is a Nuxt auto-import in the app.
beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

// `steps` arrives from the module-scope provider registry and is resolved with
// `t()` at render time; a value the catalog does not know renders verbatim, so
// the fixture asserts the rendered sentence either way.
const help = {
	provider: 'Gmail',
	url: 'https://myaccount.google.com/apppasswords',
	steps:
		'Turn on 2-Step Verification, then generate a 16-character app password and paste it here.',
};

function mountCallout(authError?: boolean) {
	return mount(PostboxAppPasswordCallout, {
		props: { help, authError },
		// <Icon> is a Nuxt component; render it as an inert stub.
		global: { plugins: [createTestI18n()], stubs: { Icon: true } },
	});
}

describe('PostboxAppPasswordCallout', () => {
	it('renders the provider name, steps and deep link', () => {
		const w = mountCallout(false);
		expect(w.text()).toContain('Gmail needs an app password');
		expect(w.text()).toContain(help.steps);
		const link = w.get('a');
		expect(link.attributes('href')).toBe(help.url);
		expect(link.attributes('target')).toBe('_blank');
		expect(link.attributes('rel')).toBe('noopener noreferrer');
	});

	it('sharpens the heading when there is an active auth error', () => {
		const w = mountCallout(true);
		expect(w.text()).toContain('Gmail needs an app password, not your account password');
	});

	it('leads with a proactive heading when there is no auth error', () => {
		const w = mountCallout(false);
		expect(w.text()).not.toContain('not your account password');
	});
});
