// @vitest-environment happy-dom
/**
 * The one second-factor form behind both password sign-ins (web and desktop
 * connect). The desktop copy used to be a weaker duplicate: no autofocus, no
 * spinner, a submit that only disabled. These pin what both surfaces now get.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { useSlots } from 'vue';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import { useTwoFactorChallenge } from '~/composables/useTwoFactorChallenge';
import TwoFactorStageForm from '../TwoFactorStageForm.vue';

beforeAll(() => {
	// `UiInput` reads its icon slots through the auto-imported `useSlots`.
	Object.assign(globalThis, { ...i18nStubs, useSlots });
});

let mounted: VueWrapper[] = [];

afterEach(() => {
	for (const w of mounted) w.unmount();
	mounted = [];
});

function mountForm(props: { isLoading?: boolean; errorMessage?: string } = {}) {
	const challenge = useTwoFactorChallenge();
	challenge.challenge();
	const w = mount(TwoFactorStageForm, {
		props: { challenge, ...props },
		global: { plugins: [createTestI18n()], components: { UiInput } },
		// Focus only lands on an element that is in the document.
		attachTo: document.body,
	});
	mounted.push(w);
	return { w, challenge };
}

describe('TwoFactorStageForm', () => {
	it('puts the cursor in the code field', () => {
		const { w } = mountForm();

		expect(document.activeElement).toBe(w.get('#two-factor-code').element);
	});

	it('holds the submit until the code is complete', async () => {
		const { w } = mountForm();
		const submit = () => w.get('button[type="submit"]');

		expect(submit().attributes('disabled')).toBeDefined();
		await w.get('#two-factor-code').setValue('12345');
		expect(submit().attributes('disabled')).toBeDefined();
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')).toBeUndefined();

		await w.get('#two-factor-code').setValue('123456');
		expect(submit().attributes('disabled')).toBeUndefined();
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')).toHaveLength(1);
	});

	it('shows the pending state on the submit and does not submit twice', async () => {
		const { w, challenge } = mountForm({ isLoading: true });
		challenge.onCodeInput('123456');
		await w.vm.$nextTick();

		const submit = w.get('button[type="submit"]');
		// The spinner is there, and the button is locked while the code is in flight.
		expect(submit.find('.animate-spin').exists()).toBe(true);
		expect(submit.attributes('disabled')).toBeDefined();
		expect(submit.text()).toContain('Verifying');
		await w.get('form').trigger('submit');
		expect(w.emitted('submit')).toBeUndefined();
	});

	it('ties a failed attempt to the code field', () => {
		const { w } = mountForm({ errorMessage: 'That code was not accepted.' });

		const input = w.get('#two-factor-code');
		expect(input.attributes('aria-invalid')).toBe('true');
		expect(w.get(`#${input.attributes('aria-describedby')}`).text()).toBe(
			'That code was not accepted.'
		);
	});

	it('switches to a backup code in place', async () => {
		const { w, challenge } = mountForm();
		await w.findAll('button[type="button"]')[0]!.trigger('click');

		expect(challenge.method.value).toBe('backup-code');
		expect(w.text()).toContain('Use your authenticator app');
	});

	it('asks the page to start over on cancel', async () => {
		const { w } = mountForm();
		const buttons = w.findAll('button[type="button"]');
		await buttons[buttons.length - 1]!.trigger('click');

		expect(w.emitted('cancel')).toHaveLength(1);
	});
});
