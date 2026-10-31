// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import ClientSelector from '../ClientSelector.vue';
import { devicePresets, emailClients } from '../../data/clients';
import type { DevicePreset, EmailClient } from '../../types';

/**
 * The client and device pickers: one dropdown open at a time, a pick closes
 * it, and the backdrop closes either.
 */
let wrapper: VueWrapper | null = null;
afterEach(() => {
	wrapper?.unmount();
	wrapper = null;
});

const desktop = devicePresets.find((d) => d.type === 'desktop')!;
const mobile = devicePresets.find((d) => d.type === 'mobile')!;

const mountSelector = (selectedClient: EmailClient | null = null) => {
	wrapper = mount(ClientSelector, {
		props: { selectedClient, selectedDevice: desktop },
	});
	return wrapper;
};

const buttons = (w: VueWrapper) => w.findAll('.ep-selector-button');

describe('ClientSelector', () => {
	it('picks a client from the list and closes the dropdown', async () => {
		const w = mountSelector();
		expect(buttons(w)[0]!.text()).toContain('All Clients');
		await buttons(w)[0]!.trigger('click');
		expect(w.find('.ep-dropdown-clients').exists()).toBe(true);
		expect(w.findAll('.ep-client-chip').length).toBeGreaterThan(0);

		const outlook = emailClients.find((c) => c.id === 'outlook-windows')!;
		const item = w.findAll('.ep-client-item').find((i) => i.text().includes(outlook.name))!;
		await item.trigger('click');
		expect(w.emitted<[EmailClient | null]>('update:selectedClient')?.at(-1)?.[0]).toEqual(outlook);
		expect(w.find('.ep-dropdown-clients').exists()).toBe(false);
	});

	it('marks the selected client and clears it', async () => {
		const gmail = emailClients.find((c) => c.id === 'gmail-webmail')!;
		const w = mountSelector(gmail);
		expect(buttons(w)[0]!.text()).toContain(gmail.name);
		await buttons(w)[0]!.trigger('click');
		expect(w.find('.ep-client-item.ep-client-selected').text()).toContain(gmail.name);
		expect(w.find('.ep-client-item.ep-client-selected .ep-client-check').exists()).toBe(true);

		await w.find('.ep-clear-button').trigger('click');
		expect(w.emitted('update:selectedClient')?.at(-1)).toEqual([null]);
	});

	it('picks a device grouped by type, with one dropdown open at a time', async () => {
		const w = mountSelector();
		await buttons(w)[0]!.trigger('click');
		await buttons(w)[1]!.trigger('click');
		expect(w.find('.ep-dropdown-clients').exists()).toBe(false);
		expect(w.findAll('.ep-dropdown-devices .ep-dropdown-section')).toHaveLength(3);
		expect(w.find('.ep-device-item.ep-device-selected').text()).toContain(
			`${desktop.width} × ${desktop.height}`
		);

		const item = w
			.findAll('.ep-device-item')
			.find((i) => i.text().includes(`${mobile.width} × ${mobile.height}`))!;
		await item.trigger('click');
		expect(w.emitted<[DevicePreset]>('update:selectedDevice')?.at(-1)?.[0]).toEqual(mobile);
		expect(w.find('.ep-dropdown-devices').exists()).toBe(false);
	});

	it('closes an open dropdown from the backdrop', async () => {
		const w = mountSelector();
		await buttons(w)[1]!.trigger('click');
		await w.find('.ep-dropdown-backdrop').trigger('click');
		expect(w.find('.ep-dropdown-devices').exists()).toBe(false);
		expect(w.find('.ep-dropdown-backdrop').exists()).toBe(false);
	});
});
