// @vitest-environment happy-dom
/**
 * Mailchimp Transactional on the connect-a-provider wizard.
 *
 * The migration story starts here: a team arriving from Mailchimp has to be able
 * to pick Mandrill, hand over one key, and land on the same sealed env patch
 * every other relay uses. The three things worth pinning are the ones that were
 * SES-only before this piece: the option exists, the key is written to the right
 * variable, and nothing about it takes a different path out of the browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { buildProviderEnv } from '~/composables/useSetupWizard';
import { validateEmailStep } from '~/composables/setupWizardValidation';
import { buttonByText, fillCredentials, mountWizard, openWizard } from './wizardHarness';

const KEY = 'md-9f3c2b7a41';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	fetchMock = vi.fn(async () => ({
		ok: true,
		message: 'Applied.',
		applied: true,
		requiresRestart: false,
	}));
	vi.stubGlobal('$fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function emailDraft(over: Record<string, unknown> = {}) {
	return {
		provider: 'mandrill' as const,
		requiresProvider: true,
		resendKey: '',
		mandrillKey: KEY,
		ses: { region: '', accessKeyId: '', secretAccessKey: '' },
		smtp: {
			preset: 'custom' as const,
			host: '',
			port: '',
			secure: false,
			username: '',
			password: '',
		},
		fromEmail: '',
		fromName: '',
		...over,
	};
}

describe('transport wizard — Mailchimp Transactional', () => {
	it('offers Mandrill as a connectable relay', async () => {
		const wrapper = mountWizard();
		await openWizard(wrapper);
		expect(wrapper.find('input[type="radio"][value="mandrill"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Mailchimp Transactional');
	});

	it('renders its one credential field, labelled', async () => {
		const wrapper = mountWizard();
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'mandrill', KEY);
		const field = wrapper.find('#field-mailchimp-transactional-api-key');
		expect(field.exists()).toBe(true);
		expect(field.attributes('type')).toBe('password');
	});

	it('names the webhook key without ever asking for it here', async () => {
		// It is not a SENDING credential and Mandrill only issues it after the
		// webhook exists, so the wizard points at it rather than collecting it.
		const wrapper = mountWizard();
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'mandrill', KEY);
		expect(wrapper.text()).toContain('MANDRILL_WEBHOOK_KEY');
	});

	it('applies through the same sealed env patch as every other relay', async () => {
		const wrapper = mountWizard();
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'mandrill', KEY);
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();

		const calls = fetchMock.mock.calls as [
			string,
			{ body: { providerEnv: Record<string, string> } },
		][];
		const applied = calls.filter(([url]) => url === '/api/delivery/apply-transport');
		expect(applied).toHaveLength(1);
		expect(applied[0]![1].body.providerEnv).toMatchObject({
			EMAIL_PROVIDER: 'mandrill',
			MANDRILL_API_KEY: KEY,
		});
	});

	it('never fires the pre-apply handshake — Mandrill has none', async () => {
		const wrapper = mountWizard();
		await openWizard(wrapper);
		await fillCredentials(wrapper, 'mandrill', KEY);
		await buttonByText(wrapper, 'Save credentials').trigger('click');
		await flushPromises();

		const calls = fetchMock.mock.calls as [string, unknown][];
		expect(calls.some(([url]) => url === '/api/delivery/validate-transport')).toBe(false);
	});
});

describe('Mandrill in the shared transport draft rules', () => {
	it('writes only the sending key — never the webhook key, subaccount or pool', () => {
		const env = buildProviderEnv({}, emailDraft());
		expect(env['MANDRILL_API_KEY']).toBe(KEY);
		expect(env['MANDRILL_WEBHOOK_KEY']).toBeUndefined();
		expect(env['MANDRILL_SUBACCOUNT']).toBeUndefined();
		expect(env['MANDRILL_IP_POOL']).toBeUndefined();
	});

	it('clears the Mandrill key when the transport moves elsewhere', () => {
		const env = buildProviderEnv(
			{ MANDRILL_API_KEY: KEY },
			emailDraft({ provider: 'resend', resendKey: 're_x', mandrillKey: '' })
		);
		expect(env['MANDRILL_API_KEY']).toBeUndefined();
		expect(env['RESEND_API_KEY']).toBe('re_x');
	});

	it('requires the key before the step is valid', () => {
		expect(validateEmailStep(emailDraft({ mandrillKey: '   ' })).mandrillKey).toBeTruthy();
		expect(validateEmailStep(emailDraft()).mandrillKey).toBeUndefined();
	});
});
