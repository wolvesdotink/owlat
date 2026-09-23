// @vitest-environment happy-dom
/**
 * The shared "this needs an environment variable" block: the exact `.env`
 * lines, the exact `owlat` commands, a poll while the server has not seen them,
 * and a flip to "Connected" once it has.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import EnvSetupSteps from '../EnvSetupSteps.vue';
import TransportCanSendCard from '../TransportCanSendCard.vue';

const copy = vi.fn();
Object.assign(globalThis, {
	useI18n: i18nStubs.useI18n,
	useCopyToClipboard: () => ({ copy, isCopied: () => false }),
});
config.global.plugins = [...(config.global.plugins ?? []), createTestI18n()];

const stubs = {
	Icon: { template: '<i />' },
	UiCard: { template: '<section><slot /></section>' },
	UiButton: {
		emits: ['click'],
		template: '<button type="button" @click="$emit(\'click\')"><slot /></button>',
	},
};

beforeEach(() => {
	vi.useFakeTimers();
	copy.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
});

function mountSteps(props: { variables: readonly string[]; connected: boolean }) {
	return mount(EnvSetupSteps, { props, global: { stubs } });
}

describe('EnvSetupSteps', () => {
	it('hands over the .env lines and the owlat commands, names only', () => {
		const wrapper = mountSteps({
			variables: ['AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID'],
			connected: false,
		});
		expect(wrapper.find('[data-testid="env-setup-env"]').text()).toBe(
			'AWS_SES_REGION=\nAWS_SES_ACCESS_KEY_ID='
		);
		expect(wrapper.find('[data-testid="env-setup-cli"]').text()).toBe(
			'owlat env AWS_SES_REGION <value>\nowlat env AWS_SES_ACCESS_KEY_ID <value>\nowlat restart'
		);
		expect(wrapper.find('[data-testid="env-setup-waiting"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('copies exactly what it shows', async () => {
		const wrapper = mountSteps({ variables: ['MANDRILL_API_KEY'], connected: false });
		await wrapper.find('[data-testid="env-setup-copy-env"]').trigger('click');
		await wrapper.find('[data-testid="env-setup-copy-cli"]').trigger('click');
		expect(copy).toHaveBeenNthCalledWith(1, 'MANDRILL_API_KEY=', 'env-setup-env');
		expect(copy).toHaveBeenNthCalledWith(
			2,
			'owlat env MANDRILL_API_KEY <value>\nowlat restart',
			'env-setup-cli'
		);
		wrapper.unmount();
	});

	it('asks the page to look again while waiting, and on "Check now"', async () => {
		const wrapper = mountSteps({ variables: ['MANDRILL_API_KEY'], connected: false });
		expect(wrapper.emitted('refresh')).toBeUndefined();
		vi.advanceTimersByTime(5_000);
		expect(wrapper.emitted('refresh')).toHaveLength(1);
		vi.advanceTimersByTime(10_000);
		expect(wrapper.emitted('refresh')).toHaveLength(3);
		await wrapper.find('[data-testid="env-setup-check-now"]').trigger('click');
		expect(wrapper.emitted('refresh')).toHaveLength(4);
		wrapper.unmount();
	});

	it('flips to "Connected" and stops polling once the server sees the value', async () => {
		const wrapper = mountSteps({ variables: ['MANDRILL_API_KEY'], connected: false });
		await wrapper.setProps({ connected: true });
		expect(wrapper.find('[data-testid="env-setup-connected"]').text()).toBe('Connected');
		expect(wrapper.find('[data-testid="env-setup-env"]').exists()).toBe(false);
		vi.advanceTimersByTime(30_000);
		expect(wrapper.emitted('refresh')).toBeUndefined();
		wrapper.unmount();
	});

	it('stops polling when it goes away', () => {
		const wrapper = mountSteps({ variables: ['MANDRILL_API_KEY'], connected: false });
		wrapper.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('TransportCanSendCard', () => {
	function mountCard(props: { canSend: boolean; missingEnv: readonly string[] }) {
		return mount(TransportCanSendCard, {
			props,
			global: { stubs, components: { DeliveryEnvSetupSteps: EnvSetupSteps } },
		});
	}

	it('shows the remedy for the missing variables when the instance cannot send', () => {
		const wrapper = mountCard({ canSend: false, missingEnv: ['RESEND_API_KEY'] });
		expect(wrapper.text()).toContain('This instance cannot send email');
		expect(wrapper.find('[data-testid="env-setup-env"]').text()).toBe('RESEND_API_KEY=');
		// The old copy told the operator to set EMAIL_PROVIDER and nothing else.
		expect(wrapper.text()).not.toContain('Set EMAIL_PROVIDER');
		wrapper.unmount();
	});

	it('says "Connected" when the status it was waiting on flips', async () => {
		const wrapper = mountCard({ canSend: false, missingEnv: ['RESEND_API_KEY'] });
		vi.advanceTimersByTime(5_000);
		expect(wrapper.emitted('refresh')).toHaveLength(1);
		await wrapper.setProps({ canSend: true, missingEnv: [] });
		await nextTick();
		expect(wrapper.text()).toContain('This instance can send email');
		expect(wrapper.find('[data-testid="env-setup-connected"]').text()).toContain('Connected');
		wrapper.unmount();
	});

	it('does not congratulate a deployment that was healthy all along', () => {
		const wrapper = mountCard({ canSend: true, missingEnv: [] });
		expect(wrapper.find('[data-testid="env-setup-steps"]').exists()).toBe(false);
		wrapper.unmount();
	});
});
