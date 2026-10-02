<script setup lang="ts">
/**
 * The brand kit's live preview: a sample email built from the kit's own
 * logo, text, button and footer Blocks and rendered by the same renderer and
 * theme projection that send real emails, so what it shows is what goes out.
 */
import type { EditorBlock } from '@owlat/email-builder';
import { renderEmailHtml } from '@owlat/email-renderer';
import { DEFAULT_BLOCK_PADDING } from '@owlat/shared/emailDefaults';
import { escapeHtml } from '@owlat/shared/html';
import {
	brandBlockStyles,
	brandKitEmailTheme,
	brandWebFontUrls,
	type BrandKitDesign,
} from '@owlat/shared/brandKit';
import { brandFooterBlocks, brandLogoBlock, type BrandLogos } from '@owlat/shared/brandKitBlocks';

const props = defineProps<{
	design: Omit<BrandKitDesign, 'isConfigured'>;
	logos: BrandLogos;
}>();

const { t } = useI18n();
const mode = ref<'light' | 'dark'>('light');

const modeOptions = computed(() => [
	{ value: 'light', label: t('dashboard.admin.instance.brandKit.preview.light') },
	{ value: 'dark', label: t('dashboard.admin.instance.brandKit.preview.dark') },
]);

const fullDesign = computed<BrandKitDesign>(() => ({ ...props.design, isConfigured: true }));

const blocks = computed<EditorBlock[]>(() => {
	const design = fullDesign.value;
	let n = 0;
	const id = () => `preview-${n++}`;
	const styles = brandBlockStyles(design);
	const logo = brandLogoBlock(design, props.logos, id);
	return [
		...(logo ? [logo] : []),
		{
			id: id(),
			type: 'text',
			content: {
				html: escapeHtml(t('dashboard.admin.instance.brandKit.preview.heading')),
				blockType: 'h1',
				fontSize: 28,
				textColor: design.textColor,
				lineHeight: 1.3,
				...DEFAULT_BLOCK_PADDING,
			},
		},
		{
			id: id(),
			type: 'text',
			content: {
				html: `${escapeHtml(t('dashboard.admin.instance.brandKit.preview.body'))} <a href="https://example.com">${escapeHtml(t('dashboard.admin.instance.brandKit.preview.link'))}</a>.`,
				blockType: 'paragraph',
				fontSize: 16,
				textColor: design.textColor,
				lineHeight: 1.6,
				...DEFAULT_BLOCK_PADDING,
			},
		},
		{
			id: id(),
			type: 'button',
			content: {
				text: t('dashboard.admin.instance.brandKit.preview.button'),
				url: 'https://example.com',
				align: 'left',
				backgroundColor: design.primaryColor,
				textColor: styles.button?.textColor ?? '#ffffff',
				borderRadius: design.buttonRadius,
				paddingX: design.buttonPaddingX,
				paddingY: design.buttonPaddingY,
				...DEFAULT_BLOCK_PADDING,
			},
		},
		{
			id: id(),
			type: 'divider',
			content: { color: design.secondaryColor, thickness: 1, width: 100, style: 'solid' },
		},
		...brandFooterBlocks(design, id),
	] as EditorBlock[];
});

/**
 * The email's dark-mode rules (and the dark logo swap) sit behind
 * `prefers-color-scheme`, which in the frame follows the viewer's OS. The
 * preview pins that query to the toggle so "Light" shows light on a dark OS
 * and "Dark" shows the dark logo on a light one.
 */
const html = computed(() =>
	renderEmailHtml(blocks.value, {
		theme: brandKitEmailTheme(fullDesign.value),
		variableType: 'personalization',
		darkMode: mode.value === 'dark',
	}).replaceAll('(prefers-color-scheme:dark)', mode.value === 'dark' ? 'all' : 'not all')
);

const usesWebFont = computed(
	() => brandWebFontUrls(props.design.headingFontFamily, props.design.bodyFontFamily).length > 0
);
</script>

<template>
	<div class="card p-0 overflow-hidden xl:sticky xl:top-6">
		<div class="px-6 py-4 border-b border-border-subtle flex items-center justify-between gap-4">
			<div class="min-w-0">
				<h2 class="text-lg font-semibold text-text-primary">
					{{ t('dashboard.admin.instance.brandKit.preview.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('dashboard.admin.instance.brandKit.preview.subtitle') }}
				</p>
			</div>
			<UiSegmentedControl v-model="mode" :options="modeOptions" size="sm" fit="content" />
		</div>
		<div class="p-4 bg-bg-surface">
			<!-- palette-ok: the email document paints its own background; white until it loads -->
			<iframe
				:srcdoc="html"
				sandbox=""
				:title="t('dashboard.admin.instance.brandKit.preview.frameTitle')"
				class="w-full h-[640px] rounded-lg border border-border-subtle bg-white"
				data-testid="brand-kit-preview"
			/>
			<p v-if="usesWebFont" class="mt-3 text-xs text-text-tertiary">
				{{ t('dashboard.admin.instance.brandKit.typography.webFontHelp') }}
			</p>
		</div>
	</div>
</template>
