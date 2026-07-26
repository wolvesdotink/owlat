// @vitest-environment happy-dom
import type { Id } from '@owlat/api/dataModel';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliverabilityChecklistItem } from '~/utils/deliverabilityCenter';
import DeliverabilityNextActionCard from '../DeliverabilityNextActionCard.vue';

const copy = vi.fn(async () => true);
const isCopied = vi.fn(() => false);

const stubs = {
	Icon: { template: '<i />' },
	NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
	UiButton: {
		props: ['disabled', 'loading'],
		emits: ['click'],
		template:
			'<button :disabled="disabled" @click="$emit(\'click\')"><slot /><slot name="iconLeft" /></button>',
	},
	UiCard: { template: '<section><slot /></section>' },
	UiIconBox: { template: '<i />' },
};

function item(status: DeliverabilityChecklistItem['status']): DeliverabilityChecklistItem {
	return {
		id: 'deployment.ptr',
		title: "Prove you own your server's address",
		protocol: 'Reverse DNS (PTR)',
		severity: 'blocking',
		impact: 'Until this is set, Gmail can slow down or refuse your mail.',
		docsHref: '/guide/sending-from-a-vps',
		dependencies: [],
		dnsBacked: true,
		scope: { kind: 'deployment' },
		status,
		lastCheckedAt: Date.now() - 60_000,
		observed: ['static.7.113.0.203.example'],
		failureReason: status === 'fail' ? 'The address still has a provider-default name.' : undefined,
		nextStep: 'Set the reverse DNS name at your VPS provider.',
		records: [
			{
				id: 'ptr',
				label: 'Reverse DNS',
				name: '203.0.113.7',
				type: 'PTR',
				value: 'mail.example.com',
				ttl: 3600,
			},
		],
		instructions: {
			provider: 'hetzner',
			providerLabel: 'Hetzner',
			steps: ['Open Networking.', 'Edit reverse DNS.'],
		},
		diagnosticReport: 'PTR 203.0.113.7 returned static.7.113.0.203.example',
		verification:
			status === 'pending-dns' ? { nextCheckAt: Date.now() + 4 * 60_000 + 32_000 } : undefined,
	};
}

function mountCard(check: DeliverabilityChecklistItem) {
	return mount(DeliverabilityNextActionCard, {
		props: { item: check },
		global: { stubs },
	});
}

beforeEach(() => {
	copy.mockClear();
	isCopied.mockClear();
	vi.stubGlobal('useCopyToClipboard', () => ({ copy, isCopied }));
});

describe('DeliverabilityNextActionCard', () => {
	it('renders DNS propagation as waiting, never as a failure', () => {
		const wrapper = mountCard(item('pending-dns'));
		expect(wrapper.text()).toContain('Checking for your change');
		expect(wrapper.text()).toContain('DNS can take up to an hour');
		expect(wrapper.text()).toContain('You can safely leave this page');
		expect(wrapper.text()).not.toContain('Not working');
	});

	it('copies exact values with a scope-qualified key', async () => {
		const wrapper = mountCard(item('fail'));
		const button = wrapper
			.findAll('button')
			.find((candidate) => candidate.attributes('aria-label') === 'Copy value for 203.0.113.7');
		expect(button).toBeDefined();
		await button!.trigger('click');
		expect(copy).toHaveBeenCalledWith('mail.example.com', 'deployment:deployment.ptr:ptr:value');
	});

	it('emits verification only from the live-check action', async () => {
		const check = item('fail');
		const wrapper = mountCard(check);
		const button = wrapper
			.findAll('button')
			.find((candidate) => candidate.text().includes('verify now'));
		expect(button).toBeDefined();
		await button!.trigger('click');
		expect(wrapper.emitted('verify')).toEqual([[check]]);
	});

	it('keeps two domains distinct even when the checklist id is identical', async () => {
		const check = {
			...item('fail'),
			id: 'domain.spf' as const,
			scope: {
				kind: 'domain' as const,
				domainId: 'domain-a' as Id<'domains'>,
				domain: 'a.example',
			},
		};
		const wrapper = mountCard(check);
		await wrapper
			.findAll('button')
			.find((candidate) => candidate.attributes('aria-label') === 'Copy value for 203.0.113.7')!
			.trigger('click');
		expect(copy).toHaveBeenCalledWith('mail.example.com', 'domain:domain-a:domain.spf:ptr:value');
	});
});
