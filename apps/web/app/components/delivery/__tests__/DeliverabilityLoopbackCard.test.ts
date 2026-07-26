// @vitest-environment happy-dom
import type { Id } from '@owlat/api/dataModel';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import DeliverabilityLoopbackCard from '../DeliverabilityLoopbackCard.vue';

const domains = [{ id: 'domain-a' as Id<'domains'>, domain: 'example.com', eligible: true }];
const stubs = {
	Icon: { template: '<i />' },
	UiButton: {
		props: ['disabled', 'loading'],
		emits: ['click'],
		template:
			'<button :disabled="disabled" @click="$emit(\'click\')"><slot /><slot name="iconLeft" /></button>',
	},
	UiCard: { template: '<section><slot name="header" /><slot /></section>' },
	UiIconBox: { template: '<i />' },
};

describe('DeliverabilityLoopbackCard', () => {
	it('explains why proof is locked before required checks pass', () => {
		const wrapper = mount(DeliverabilityLoopbackCard, {
			props: {
				domains: [{ ...domains[0]!, eligible: false, blockedReason: 'Verify SPF and DKIM first.' }],
			},
			global: { stubs },
		});
		expect(wrapper.text()).toContain('Finish required checks first');
		expect(wrapper.text()).toContain('Verify SPF and DKIM first.');
	});

	it.each([
		['sending', 'Sending probe'],
		['awaiting_inbound', 'Waiting for receipt'],
	] as const)('preserves the %s in-flight status', (status, label) => {
		const wrapper = mount(DeliverabilityLoopbackCard, {
			props: {
				domains: [
					{
						...domains[0]!,
						latest: { status, startedAt: Date.now(), domain: 'example.com' },
					},
				],
			},
			global: { stubs },
		});
		expect(wrapper.text()).toContain(label);
		expect(wrapper.text()).toContain('Running proof…');
	});

	it('renders a timed-out proof distinctly from a receiver failure', () => {
		const wrapper = mount(DeliverabilityLoopbackCard, {
			props: {
				domains: [
					{
						...domains[0]!,
						latest: {
							status: 'timed_out',
							startedAt: Date.now() - 60_000,
							completedAt: Date.now(),
							domain: 'example.com',
							detail: 'No inbound probe arrived before the deadline.',
						},
					},
				],
			},
			global: { stubs },
		});
		expect(wrapper.text()).toContain('Probe timed out');
		expect(wrapper.text()).toContain('No inbound probe arrived before the deadline.');
		expect(wrapper.text()).not.toContain('Waiting for receipt');
	});

	it('emits the selected domain for an eligible proof', async () => {
		const wrapper = mount(DeliverabilityLoopbackCard, {
			props: { domains },
			global: { stubs },
		});
		expect(wrapper.text()).not.toContain('Finish required checks first');
		const button = wrapper
			.findAll('button')
			.find((candidate) => candidate.text().includes('Run end-to-end proof'));
		expect(button).toBeDefined();
		expect(button!.attributes('disabled')).toBeUndefined();
		await button!.trigger('click');
		expect(wrapper.emitted('start')).toEqual([['domain-a']]);
	});

	it('shows only the latest result for the selected domain', async () => {
		const wrapper = mount(DeliverabilityLoopbackCard, {
			props: {
				domains: [
					{
						...domains[0]!,
						latest: { status: 'passed', startedAt: 1, domain: 'a.example' },
					},
					{
						id: 'domain-b' as Id<'domains'>,
						domain: 'b.example',
						eligible: true,
						latest: {
							status: 'failed',
							startedAt: 2,
							domain: 'b.example',
							detail: 'B failed.',
						},
					},
				],
			},
			global: { stubs },
		});
		expect(wrapper.text()).toContain('Result for a.example');
		await wrapper.find('select').setValue('domain-b');
		expect(wrapper.text()).toContain('Result for b.example');
		expect(wrapper.text()).toContain('B failed.');
		expect(wrapper.text()).not.toContain('Result for a.example');
	});
});
