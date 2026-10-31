/**
 * The email step says what it does, hints only while nothing is picked, marks
 * the chosen provider as selected, does not ask for hand-written JSON (per-IP
 * EHLO overrides stay an `.env` setting), and draws each transport's credential
 * form from its catalog entry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { ref, type Ref } from 'vue';
import { getDefaultFlags } from '@owlat/shared/featureFlags';
import { installNuxtStubs, mountDashboardPage } from '~/__tests__/a11y';
import { i18nStubs } from '~/__tests__/i18n';
import { useSetupWizard } from '~/composables/useSetupWizard';
import { useWizard } from '~/composables/useWizard';
import { SETUP_CHOICE_SELECTED } from '~/utils/setupChoiceCard';
import UiInput from '@owlat/ui/components/ui/Input.vue';
import SetupEmailPage from '../email.vue';

let state: Map<string, Ref<unknown>>;

function install(flags: Record<string, boolean>, env: Record<string, string> = {}) {
	sessionStorage.clear();
	state = new Map<string, Ref<unknown>>([
		['setupFlags', ref({ ...getDefaultFlags(), ...flags })],
		['setupEnv', ref({ ...env })],
	]);
	installNuxtStubs({
		...i18nStubs,
		useState: (key: string, init?: () => unknown) => {
			if (!state.has(key)) state.set(key, ref(init?.()));
			return state.get(key);
		},
		useSetupWizard,
		useWizard,
		useRoute: () => ({
			path: '/setup/email',
			fullPath: '/setup/email',
			query: {},
			params: {},
			meta: {},
		}),
	});
}

function mountStep() {
	return mountDashboardPage(SetupEmailPage, {
		stubs: {
			UiHeroField: true,
			UiStepIndicator: true,
			UiCard: { template: '<div><slot /></div>' },
			UiErrorAlert: true,
			UiSelect: true,
			UiSwitch: true,
		},
		components: { UiInput },
	});
}

const NO_BULK = { campaigns: false, transactional: false, automations: false, inbox: false };

describe('setup email step', () => {
	beforeEach(() => install(NO_BULK));

	it('introduces the step without miscounting the options', () => {
		const wrapper = mountStep();
		expect(wrapper.text()).toContain('Pick how Owlat sends mail.');
		expect(wrapper.text()).not.toMatch(/Three honest ways/);
	});

	it('shows a neutral hint while no provider is picked, and hides it once one is', async () => {
		const wrapper = mountStep();
		const hint = wrapper.get('[data-testid="setup-provider-hint"]');
		expect(hint.classes()).not.toContain('text-error');
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);

		await wrapper.get('input[type="radio"][value="mta"]').setValue(true);
		expect(wrapper.find('[data-testid="setup-provider-hint"]').exists()).toBe(false);
	});

	it('marks the selected provider with the brand-tinted selected style', async () => {
		const wrapper = mountStep();
		await wrapper.get('input[type="radio"][value="mta"]').setValue(true);
		const card = wrapper.get('input[type="radio"][value="mta"]').element.closest('label');
		for (const cls of SETUP_CHOICE_SELECTED.split(' ')) {
			expect(card?.classList.contains(cls)).toBe(true);
		}
		expect(card?.classList.contains('bg-(--surface-2-selected)')).toBe(false);
	});

	it('does not ask for per-IP EHLO overrides as JSON', async () => {
		const wrapper = mountStep();
		await wrapper.get('input[type="radio"][value="mta"]').setValue(true);
		expect(wrapper.text()).toContain('Outbound IP identity');
		expect(wrapper.text()).not.toMatch(/EHLO overrides|JSON/);
	});
});

describe('setup email step with bulk sending on', () => {
	beforeEach(() => install({ campaigns: true }));

	it('shows no banner, because a provider is already preselected', () => {
		const wrapper = mountStep();
		expect(wrapper.find('[data-testid="setup-provider-hint"]').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('A delivery provider is required');
	});
});

/** The label of every text-like input the step currently draws. */
function inputLabels(wrapper: ReturnType<typeof mountStep>): string[] {
	return wrapper.findAll('label').map((label) => label.text().trim());
}

/** The input a label names, as an operator (and a screen reader) finds it. */
function inputByLabel(wrapper: ReturnType<typeof mountStep>, text: string) {
	const label = wrapper.findAll('label').find((candidate) => candidate.text().trim() === text);
	if (label === undefined) throw new Error(`no field labelled "${text}"`);
	return wrapper.get<HTMLInputElement>(`[id="${label.attributes('for')}"]`);
}

describe('setup email step, credentials from the catalog', () => {
	beforeEach(() => install({ campaigns: true }));

	it.each([
		['ses', ['Region', 'Access key ID', 'Secret access key']],
		['resend', ['Resend API key']],
		['mandrill', ['Mailchimp Transactional API key']],
		['emailit', ['Emailit API key']],
		['smtp', ['Server host', 'Port', 'Username', 'Password']],
	])('draws %s’s declared fields', async (kind, labels) => {
		const wrapper = mountStep();
		await wrapper.get(`input[type="radio"][value="${kind}"]`).setValue(true);
		expect(inputLabels(wrapper)).toEqual(expect.arrayContaining(labels));
	});

	it('asks for the setup token exactly when the selected kind declares a live check', async () => {
		const wrapper = mountStep();
		for (const [kind, probed] of [
			['resend', true],
			['emailit', true],
			['smtp', true],
			['ses', false],
			['mandrill', false],
			['mta', false],
		] as const) {
			await wrapper.get(`input[type="radio"][value="${kind}"]`).setValue(true);
			expect(inputLabels(wrapper).includes('Setup token'), kind).toBe(probed);
		}
	});

	it('announces an incomplete credential set after an advance attempt', async () => {
		const wrapper = mountStep();
		await wrapper.get('input[type="radio"][value="ses"]').setValue(true);
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);

		await wrapper.get('form').trigger('submit');
		expect(wrapper.get('[role="alert"]').text()).toBe(
			'Region, access key ID, and secret access key are all required for SES.'
		);
	});

	it('checks a probed kind live, with the setup token, before committing it', async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, message: 'ok' }));
		vi.stubGlobal('$fetch', fetchMock);
		const wrapper = mountStep();
		await wrapper.get('input[type="radio"][value="resend"]').setValue(true);
		await inputByLabel(wrapper, 'Resend API key').setValue('re_live_123');
		await inputByLabel(wrapper, 'Setup token').setValue('stk_test');

		await wrapper.get('form').trigger('submit');
		await flushPromises();

		expect(fetchMock).toHaveBeenCalledWith(
			'/api/setup/validate-provider',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ 'X-Setup-Token': 'stk_test' }),
				body: { provider: 'resend', apiKey: 're_live_123' },
			})
		);
		expect(state.get('setupEnv')?.value).toMatchObject({
			EMAIL_PROVIDER: 'resend',
			RESEND_API_KEY: 're_live_123',
		});
	});

	it('commits a kind without a live check straight away', async () => {
		const fetchMock = vi.fn(async () => ({ ok: true, message: 'ok' }));
		vi.stubGlobal('$fetch', fetchMock);
		const wrapper = mountStep();
		await wrapper.get('input[type="radio"][value="mandrill"]').setValue(true);
		await inputByLabel(wrapper, 'Mailchimp Transactional API key').setValue('md-123');

		await wrapper.get('form').trigger('submit');
		await flushPromises();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(state.get('setupEnv')?.value).toMatchObject({
			EMAIL_PROVIDER: 'mandrill',
			MANDRILL_API_KEY: 'md-123',
		});
	});
});

describe('setup email step, re-opened from a collected env', () => {
	// The wizard persists the env it has collected, not the step's form, so a
	// draft saved before the step drew its form from the catalog loads the same.
	beforeEach(() =>
		install(
			{ campaigns: true },
			{
				EMAIL_PROVIDER: 'smtp',
				SMTP_RELAY_HOST: 'relay.acme.test',
				SMTP_RELAY_PORT: '2525',
				SMTP_RELAY_SECURE: 'false',
				SMTP_RELAY_USERNAME: 'postmaster',
				SMTP_RELAY_PASSWORD: 'relay-secret',
			}
		)
	);

	it('shows the transport and every value the operator entered', () => {
		const wrapper = mountStep();
		expect(
			(wrapper.get('input[type="radio"][value="smtp"]').element as HTMLInputElement).checked
		).toBe(true);
		expect(inputByLabel(wrapper, 'Server host').element.value).toBe('relay.acme.test');
		// A host no preset names is the hand-entered endpoint, so it stays editable.
		expect(inputByLabel(wrapper, 'Server host').attributes('disabled')).toBeUndefined();
		expect(inputByLabel(wrapper, 'Port').element.value).toBe('2525');
		expect(inputByLabel(wrapper, 'Username').element.value).toBe('postmaster');
	});
});
