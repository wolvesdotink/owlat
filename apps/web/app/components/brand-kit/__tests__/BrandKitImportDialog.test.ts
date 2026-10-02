/**
 * "Import from website": the proposal is reviewed before anything is used,
 * only a chosen logo is imported into the media library, and the selection
 * goes back to the form unsaved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { ref } from 'vue';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import ImportDialog from '../ImportDialog.vue';

const importFromWebsite = vi.fn();
const importLogo = vi.fn();

beforeEach(() => {
	importFromWebsite.mockReset();
	importLogo.mockReset();
	Object.assign(globalThis, {
		useI18n: i18nStubs.useI18n,
		useBackendOperation: (fn: FunctionReference<'action'>) => {
			const name = getFunctionName(fn);
			const run = name.endsWith('importLogo') ? importLogo : importFromWebsite;
			return {
				run: async (args: unknown) => ({ ok: true, result: await run(args) }),
				isLoading: ref(false),
			};
		},
	});
});

const PROPOSAL = {
	url: 'https://www.example.com/',
	primaryColor: '#0f766e',
	secondaryColor: null,
	textColor: '#1f2937',
	backgroundColor: '#ffffff',
	linkColor: '#0f766e',
	swatches: ['#facc15'],
	companyName: 'Northwind',
	logoCandidates: [
		{ url: 'https://www.example.com/touch.png', source: 'appleTouchIcon' },
		{ url: 'https://www.example.com/og.jpg', source: 'ogImage' },
	],
};

function mountDialog() {
	return mount(ImportDialog, {
		props: { open: true, 'onUpdate:open': () => {} },
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiModal: { template: '<div><slot /><slot name="footer" /></div>' },
				UiInput: {
					props: ['modelValue', 'error'],
					emits: ['update:modelValue'],
					template: `<div><input data-testid="url" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" /><p v-if="error" data-testid="error">{{ error }}</p></div>`,
				},
				UiCheckbox: {
					props: ['modelValue', 'label'],
					emits: ['update:modelValue'],
					template: `<label><input type="checkbox" :checked="modelValue" @change="$emit('update:modelValue', $event.target.checked)" />{{ label }}</label>`,
				},
				UiButton: {
					props: ['disabled'],
					template: '<button :disabled="disabled"><slot /></button>',
				},
			},
		},
	});
}

async function readSite(wrapper: ReturnType<typeof mountDialog>) {
	await wrapper.find('[data-testid="url"]').setValue('example.com');
	const fetchButton = wrapper.findAll('button').find((b) => b.text() === 'Read website');
	await fetchButton!.trigger('click');
	await flushPromises();
}

describe('BrandKitImportDialog', () => {
	it('shows the proposal, imports only the chosen logo and hands the selection back', async () => {
		importFromWebsite.mockResolvedValue({ ok: true, value: PROPOSAL });
		importLogo.mockResolvedValue({
			ok: true,
			value: { mediaAssetId: 'm9', url: 'https://files.example.com/l.png', storageId: 's9' },
		});
		const wrapper = mountDialog();
		await readSite(wrapper);
		expect(importFromWebsite).toHaveBeenCalledWith({ url: 'example.com' });
		expect(wrapper.find('[data-testid="brand-kit-import-proposal"]').text()).toContain('#1f2937');
		expect(importLogo).not.toHaveBeenCalled();

		await wrapper.find('[data-testid="brand-kit-import-apply"]').trigger('click');
		await flushPromises();
		expect(importLogo).toHaveBeenCalledWith({ url: 'https://www.example.com/touch.png' });
		expect(wrapper.emitted('apply')?.[0]?.[0]).toEqual({
			colors: {
				primaryColor: '#0f766e',
				textColor: '#1f2937',
				backgroundColor: '#ffffff',
				linkColor: '#0f766e',
				swatches: ['#facc15'],
			},
			companyName: 'Northwind',
			logo: { url: 'https://files.example.com/l.png', storageId: 's9', mediaAssetId: 'm9' },
		});
	});

	it('imports no logo when the admin keeps the current one', async () => {
		importFromWebsite.mockResolvedValue({ ok: true, value: PROPOSAL });
		const wrapper = mountDialog();
		await readSite(wrapper);
		await wrapper.find('input[type="radio"][value=""]').setValue();
		await wrapper.find('[data-testid="brand-kit-import-apply"]').trigger('click');
		await flushPromises();
		expect(importLogo).not.toHaveBeenCalled();
		expect(wrapper.emitted('apply')?.[0]?.[0]).not.toHaveProperty('logo');
	});

	it('shows why a site could not be read', async () => {
		importFromWebsite.mockResolvedValue({ ok: false, error: 'blocked' });
		const wrapper = mountDialog();
		await readSite(wrapper);
		expect(wrapper.find('[data-testid="error"]').text()).toContain('private network');
		expect(wrapper.emitted('apply')).toBeUndefined();
	});
});
