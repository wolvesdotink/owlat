/**
 * The brand kit preview renders a real email from the form's values (the same
 * renderer and theme projection that send emails), so a change in the form is
 * a change in the preview, light and dark.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { DEFAULT_BRAND_KIT_DESIGN } from '@owlat/shared/brandKit';
import { createTestI18n, i18nStubs } from '~/__tests__/i18n';
import Preview from '../Preview.vue';

beforeAll(() => {
	Object.assign(globalThis, { useI18n: i18nStubs.useI18n });
});

const design = {
	...DEFAULT_BRAND_KIT_DESIGN,
	primaryColor: '#0f766e',
	textColor: '#1f2937',
	headingFontFamily: "'Playfair Display', Georgia, serif",
	footerCompanyName: 'Northwind',
	footerAddress: '1 Example Street',
};

function mountPreview(overrides: Partial<typeof design> = {}) {
	return mount(Preview, {
		props: {
			design: { ...design, ...overrides },
			logos: {
				light: { url: 'https://cdn.example.com/logo.png', storageId: 's1', mediaAssetId: 'm1' },
				dark: { url: 'https://cdn.example.com/logo-dark.png', storageId: 's2', mediaAssetId: 'm2' },
			},
		},
		global: {
			plugins: [createTestI18n()],
			stubs: {
				UiSegmentedControl: {
					props: ['modelValue'],
					emits: ['update:modelValue'],
					template: `<button data-testid="mode" @click="$emit('update:modelValue', 'dark')" />`,
				},
			},
		},
	});
}

const srcdoc = (wrapper: ReturnType<typeof mountPreview>) =>
	wrapper.find('[data-testid="brand-kit-preview"]').attributes('srcdoc') ?? '';

describe('BrandKitPreview', () => {
	it('renders the logo, the button in the primary colour and the footer', () => {
		const html = srcdoc(mountPreview());
		expect(html).toContain('https://cdn.example.com/logo.png');
		expect(html).toContain('#0f766e');
		expect(html).toContain('Northwind');
		expect(html).toContain('1 Example Street');
		// The web font is linked, and the note about clients without web fonts shows.
		expect(html).toContain('fonts.googleapis.com/css2?family=Playfair+Display');
	});

	it('follows the form', async () => {
		const wrapper = mountPreview();
		await wrapper.setProps({ design: { ...design, primaryColor: '#e11d48' } });
		expect(srcdoc(wrapper)).toContain('#e11d48');
		expect(srcdoc(wrapper)).not.toContain('#0f766e');
	});

	it('renders dark mode with the dark logo', async () => {
		const wrapper = mountPreview();
		await wrapper.find('[data-testid="mode"]').trigger('click');
		await nextTick();
		expect(srcdoc(wrapper)).toContain('https://cdn.example.com/logo-dark.png');
	});

	it('follows the toggle, not the OS colour scheme', async () => {
		const wrapper = mountPreview();
		expect(srcdoc(wrapper)).not.toContain('prefers-color-scheme:dark');
		expect(srcdoc(wrapper)).toContain('@media not all{');
		await wrapper.find('[data-testid="mode"]').trigger('click');
		await nextTick();
		expect(srcdoc(wrapper)).not.toContain('prefers-color-scheme:dark');
		expect(srcdoc(wrapper)).toContain('@media all{');
	});

	it('shows the web font note only for a web font', () => {
		const withWebFont = mountPreview();
		expect(withWebFont.text()).toContain('Gmail');
		const safe = mountPreview({ headingFontFamily: 'Georgia, serif' });
		expect(safe.text()).not.toContain('Gmail');
	});
});
