// @vitest-environment happy-dom
// @vitest-environment-options {"settings": {"disableCSSFileLoading": true, "handleDisabledFileLoadingAsSuccess": true}}
/**
 * The brand kit inside the editor: brand swatches lead every colour picker,
 * new Blocks start in the kit's styles, the logo and footer insert as Blocks,
 * and "Apply brand kit" restyles the email as one undoable step.
 */
import { mount } from '@vue/test-utils';
import { computed, defineComponent, h, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRAND_KIT_DESIGN, brandKitEmailTheme } from '@owlat/shared/brandKit';
import { createDefaultContent } from '../../utils/blocks';
import { headingContent } from '../useBlockManagement';
import { useBrandKit, BRAND_SWATCHES_KEY, type UseBrandKitReturn } from '../useBrandKit';
import ColorField from '../../components/panel/fields/ColorField.vue';
import type {
	BlockType,
	ButtonBlockContent,
	EditorBlock,
	EmailBuilderBrand,
	TextBlockContent,
} from '../../types';

const design = {
	...DEFAULT_BRAND_KIT_DESIGN,
	isConfigured: true,
	primaryColor: '#0f766e',
	textColor: '#1f2937',
	bodyFontFamily: "'Inter', Arial, sans-serif",
	buttonRadius: 20,
	footerCompanyName: 'Northwind',
	footerSocialLinks: [{ platform: 'github' as const, url: 'https://github.com/example' }],
};
const brand: EmailBuilderBrand = {
	design,
	logos: {
		light: { url: 'https://cdn.example.com/logo.png', storageId: 's1', mediaAssetId: 'm1' },
		dark: null,
	},
};

function setup(options: { brand?: EmailBuilderBrand; allowed?: BlockType[] } = {}) {
	const canvasBlocks = ref<EditorBlock[]>([]);
	const commitPendingHistory = vi.fn();
	let api!: UseBrandKitReturn;
	const Host = defineComponent({
		setup() {
			api = useBrandKit({
				brand: computed(() => options.brand),
				theme: computed(() => brandKitEmailTheme(design)),
				allowedBlockTypes: computed(() => options.allowed),
				canvasBlocks,
				commitPendingHistory,
			});
			return () => h(ColorField, { value: '#0f766e', label: 'Fill' });
		},
	});
	const wrapper = mount(Host);
	return { wrapper, api, canvasBlocks, commitPendingHistory };
}

describe('useBrandKit', () => {
	it('offers the brand colours first in the colour field', () => {
		const { wrapper } = setup({ brand });
		const row = wrapper.find('[data-testid="brand-swatches"]');
		expect(row.exists()).toBe(true);
		const labels = row.findAll('button').map((b) => b.attributes('aria-label'));
		expect(labels[0]).toBe('Brand color #0f766e');
		expect(row.find('button[aria-pressed="true"]').exists()).toBe(true);
		wrapper.unmount();
	});

	it('offers nothing without a saved kit', () => {
		const { wrapper, api } = setup({
			brand: { ...brand, design: { ...design, isConfigured: false } },
		});
		expect(wrapper.find('[data-testid="brand-swatches"]').exists()).toBe(false);
		expect(api.isBrandConfigured.value).toBe(false);
		expect(api.insertableBrandBlocks.value).toEqual([]);
		expect(api.applyBrand()).toBe(0);
		wrapper.unmount();
	});

	it('builds the logo and footer Blocks, within the host allowlist', () => {
		const { wrapper, api } = setup({ brand });
		expect(api.insertableBrandBlocks.value).toEqual(['logo', 'footer']);
		expect(api.brandBlocksFor('footer').map((b) => b.type)).toEqual(['text', 'social']);
		wrapper.unmount();

		const narrow = setup({ brand, allowed: ['text', 'button'] });
		expect(narrow.api.insertableBrandBlocks.value).toEqual(['footer']);
		expect(narrow.api.brandBlocksFor('footer').map((b) => b.type)).toEqual(['text']);
		narrow.wrapper.unmount();
	});

	it('restyles the canvas as one step after committing the pending edit', () => {
		const { wrapper, api, canvasBlocks, commitPendingHistory } = setup({ brand });
		canvasBlocks.value = [
			{
				id: 'b1',
				type: 'button',
				content: {
					text: 'Go',
					url: 'https://example.com',
					backgroundColor: '#ff0000',
					textColor: '#ffffff',
					align: 'center',
					borderRadius: 0,
				} as ButtonBlockContent,
			},
		];
		const before = canvasBlocks.value;
		expect(api.applyBrand()).toBe(1);
		expect(commitPendingHistory).toHaveBeenCalledOnce();
		expect(canvasBlocks.value).not.toBe(before);
		expect(canvasBlocks.value[0]!.content).toMatchObject({
			backgroundColor: '#0f766e',
			borderRadius: 20,
		});
		wrapper.unmount();
	});

	it('links the kit web fonts into the page while the editor is open', async () => {
		const { wrapper } = setup({ brand });
		await nextTick();
		const links = document.head.querySelectorAll('link[data-owlat-brand-font]');
		expect(links).toHaveLength(1);
		expect(links[0]!.getAttribute('href')).toContain('family=Inter');
		wrapper.unmount();
		expect(document.head.querySelectorAll('link[data-owlat-brand-font]')).toHaveLength(0);
	});
});

describe('new Blocks take the theme block defaults', () => {
	const theme = brandKitEmailTheme(design);

	it('starts text, headings and buttons in the kit styles', () => {
		expect((createDefaultContent('text', theme) as TextBlockContent).textColor).toBe('#1f2937');
		expect(headingContent(2, theme).textColor).toBe('#1f2937');
		expect(createDefaultContent('button', theme)).toMatchObject({
			backgroundColor: '#0f766e',
			borderRadius: 20,
		});
	});

	it('keeps the plain defaults without a kit', () => {
		expect((createDefaultContent('text') as TextBlockContent).textColor).toBe('#374151');
		expect(headingContent(1).textColor).toBe('#374151');
	});
});

// The injection key is part of the contract with ColorField.
it('ColorField reads the brand swatches from the documented key', () => {
	expect(BRAND_SWATCHES_KEY).toBe('brandSwatches');
});
