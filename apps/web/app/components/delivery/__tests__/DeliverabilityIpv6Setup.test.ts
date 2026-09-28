// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeliverabilityIpv6Setup from '../DeliverabilityIpv6Setup.vue';
import { createTestI18n, expectFullyLocalized, i18nStubs } from '~/__tests__/i18n';

const ADDRESS = '2a01:4f8:c0c:1::25';
const runCheck = vi.fn();

vi.stubGlobal('useI18n', i18nStubs.useI18n);
vi.stubGlobal('useBackendOperation', () => ({ run: runCheck, isLoading: ref(false) }));
vi.stubGlobal('useCopyToClipboard', () => ({ copy: vi.fn(), isCopied: vi.fn(() => false) }));

function item(id: string, status: string) {
	return {
		id,
		title: id,
		protocol: 'test',
		severity: 'blocking',
		impact: 'impact',
		docsHref: 'https://docs.owlat.app',
		dependencies: [],
		dnsBacked: false,
		scope: { kind: 'deployment' },
		status,
		observed: [],
		diagnosticReport: '',
	};
}

function groups(ptrStatus = 'pass') {
	return [
		{
			key: 'blocking',
			label: 'Blocking delivery',
			description: '',
			items: [
				item('deployment.ptr', ptrStatus),
				item('deployment.fcrdns', 'pass'),
				item('deployment.ehlo_ptr', 'pass'),
				item('deployment.port25', 'pass'),
				item('deployment.dnsbl', 'pass'),
			],
		},
	] as never;
}

const REPORT = {
	ok: true,
	address: ADDRESS,
	ehloHostname: 'mail.example.com',
	returnPathDomain: 'bounces.example.com',
	ready: false,
	checks: [
		{ id: 'ptr', status: 'pass', found: ['mail.example.com'] },
		{ id: 'aaaa', status: 'fail', reason: 'missing', found: [] },
		{ id: 'spf', status: 'fail', reason: 'missing-ip6-mechanism', found: [] },
	],
	env: {
		MTA_IPV6_ENABLED: 'true',
		IP_POOLS_TRANSACTIONAL: `203.0.113.25,${ADDRESS}`,
		IP_POOLS_CAMPAIGN: `203.0.113.25,${ADDRESS}`,
	},
};

function mountSetup(ptrStatus = 'pass') {
	return mount(DeliverabilityIpv6Setup, {
		props: { groups: groups(ptrStatus) },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				Icon: { template: '<i />' },
				UiButton: {
					props: ['disabled', 'type'],
					template: '<button :type="type ?? \'button\'" :disabled="disabled"><slot /></button>',
				},
				UiInput: {
					props: ['modelValue', 'error', 'label'],
					emits: ['update:modelValue', 'blur'],
					template:
						'<label>{{ label }}<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @blur="$emit(\'blur\')" /><span v-if="error" class="error">{{ error }}</span></label>',
				},
			},
		},
	});
}

async function openAndCheck(wrapper: ReturnType<typeof mountSetup>, address = ADDRESS) {
	await wrapper.get('[data-testid="ipv6-setup-open"]').trigger('click');
	await wrapper.get('input').setValue(address);
	await wrapper.get('form').trigger('submit');
	await flushPromises();
}

describe('DeliverabilityIpv6Setup', () => {
	beforeEach(() => runCheck.mockReset());

	it('says IPv6 is off and optional, with the setup behind a button', () => {
		const wrapper = mountSetup();
		expect(wrapper.text()).toContain('IPv6 is off');
		expect(wrapper.text()).toContain('Optional.');
		expect(wrapper.find('#ipv6-setup').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('names the IPv4 checks that still have to pass first', async () => {
		const wrapper = mountSetup('warn');
		await wrapper.get('[data-testid="ipv6-setup-open"]').trigger('click');
		expect(wrapper.get('[data-testid="ipv6-ipv4-blockers"]').text()).toContain(
			"Prove you own your server's address"
		);
		expectFullyLocalized(wrapper);
	});

	it('does not call the server for text that is not an IPv6 address', async () => {
		const wrapper = mountSetup();
		await openAndCheck(wrapper, '203.0.113.25');
		expect(runCheck).not.toHaveBeenCalled();
		expect(wrapper.text()).toContain('Enter a bare IPv6 address');
	});

	it('shows each DNS result and keeps the settings back until all pass', async () => {
		runCheck.mockResolvedValue({ ok: true, result: REPORT });
		const wrapper = mountSetup();
		await openAndCheck(wrapper);
		expect(runCheck).toHaveBeenCalledWith({ address: ADDRESS });
		const checks = wrapper.get('[data-testid="ipv6-checks"]').text();
		expect(checks).toContain(`Reverse DNS for ${ADDRESS} points to mail.example.com.`);
		expect(checks).toContain('mail.example.com has no AAAA record.');
		expect(checks).toContain(`Add ip6:${ADDRESS} to the SPF record on bounces.example.com.`);
		expect(wrapper.find('[data-testid="env-setup-steps"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('hands over the exact env lines and a full down/up once every check passes', async () => {
		runCheck.mockResolvedValue({
			ok: true,
			result: {
				...REPORT,
				ready: true,
				checks: REPORT.checks.map((check) => ({ ...check, status: 'pass', reason: undefined })),
			},
		});
		const wrapper = mountSetup();
		await openAndCheck(wrapper);
		expect(wrapper.get('[data-testid="env-setup-env"]').text()).toBe(
			[
				'MTA_IPV6_ENABLED=true',
				`IP_POOLS_TRANSACTIONAL=203.0.113.25,${ADDRESS}`,
				`IP_POOLS_CAMPAIGN=203.0.113.25,${ADDRESS}`,
			].join('\n')
		);
		expect(wrapper.get('[data-testid="env-setup-cli"]').text()).toMatch(
			/owlat env MTA_IPV6_ENABLED 'true'[\s\S]*\nowlat down\nowlat up$/
		);
		expect(wrapper.find('[data-testid="ipv6-pools-unknown"]').exists()).toBe(false);
		expectFullyLocalized(wrapper);
	});

	it('asks for an append instead of a replace when the pools are unknown', async () => {
		runCheck.mockResolvedValue({
			ok: true,
			result: { ...REPORT, ready: true, env: { MTA_IPV6_ENABLED: 'true' } },
		});
		const wrapper = mountSetup();
		await openAndCheck(wrapper);
		expect(wrapper.get('[data-testid="ipv6-pools-unknown"]').text()).toContain(`,${ADDRESS}`);
	});

	it('renders a refusal as a sentence', async () => {
		runCheck.mockResolvedValue({ ok: true, result: { ok: false, refusal: 'not-public' } });
		const wrapper = mountSetup();
		await openAndCheck(wrapper, 'fd00::25');
		expect(wrapper.get('[data-testid="ipv6-refusal"]').text()).toContain(
			'Use a public IPv6 address.'
		);
		expectFullyLocalized(wrapper);
	});
});
