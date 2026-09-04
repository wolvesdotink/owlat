// @vitest-environment happy-dom
/**
 * THE WIZARD RENDERS THE SHARED REGISTRIES' COPY AS WORDS.
 *
 * The mode step and the features step are the only screens that paint
 * `@owlat/shared`'s two registries, and each one fails differently if the render
 * boundary is wrong: `operatingModes.ts` now carries `sharedPkg.*` KEYS, so a
 * card that binds them straight prints key paths at the very first operator;
 * `featureFlags.ts` still carries English, so a page that forgot the catalog
 * lookup silently paints English inside a German wizard. Mounting both against
 * the real `en` catalog is what tells those two apart from a passing grep.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { installNuxtStubs } from '~/__tests__/a11y';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import SetupModePage from '../mode.vue';
import SetupFeaturesPage from '../features.vue';

beforeEach(() => {
	localStorage.clear();
	installNuxtStubs({
		...i18nStubs,
		useSetupWizard,
		useWizard,
		useRoute: () => ({ path: '/setup', fullPath: '/setup', query: {}, params: {}, meta: {} }),
	});
});

function mountPage(component: typeof SetupModePage) {
	return mount(component, {
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiBadge: true,
				UiCard: { template: '<div><slot /></div>' },
				UiErrorAlert: true,
				UiHeroField: true,
				UiIconBox: true,
				UiStepIndicator: true,
			},
		},
	});
}

describe('setup wizard — shared registry copy', () => {
	it('names every operating mode, its audience and its description', () => {
		const wrapper = mountPage(SetupModePage);
		const text = wrapper.text();

		// One per preset, in `OPERATING_MODE_KEYS` order.
		for (const label of [
			'CRM only',
			'IMAP-only (read + personal reply)',
			'Transactional API service',
			'Marketing platform',
			'Hosted mail server (Postbox)',
			'Team inbox (shared)',
			'Team inbox + AI agent',
			'Full stack',
		]) {
			expect(text).toContain(label);
		}
		expect(text).toContain('Manage contacts and data; no email send or receive.');
		expect(text).toContain(
			'Everything: campaigns, automations, transactional, shared inbox, chat, hosted Postbox, external mailboxes, and the full AI suite.'
		);
		expectFullyLocalized(wrapper);
	});

	it('names every feature pack and flag on the features step', () => {
		const wrapper = mountPage(SetupFeaturesPage);
		const text = wrapper.text();

		expect(text).toContain('Email Client');
		expect(text).toContain('Inbox, chat, and personal mail (Postbox) as one bundle.');
		expect(text).toContain('Marketing campaigns');
		expect(text).toContain('Schedule and send broadcast campaigns to contacts and segments.');
		// The one description carrying an `@`, which the catalog has to escape as
		// `{'@'}assistant` and the compiler has to give back verbatim.
		expect(text).toContain('plus @assistant replies inside team chat');
		expectFullyLocalized(wrapper);
	});
});
