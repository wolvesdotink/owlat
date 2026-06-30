<script setup lang="ts">
import { computed } from 'vue';
import type { EditorBlock, EmailTheme, SocialBlockContent } from '../../../types';

const props = defineProps<{
	block: EditorBlock;
	theme: Required<EmailTheme>;
}>();

const content = computed(() => props.block.content as SocialBlockContent);

const wrapperStyles = computed(() => ({
	textAlign: content.value.align || ('center' as const),
	paddingTop: `${content.value.paddingTop ?? 16}px`,
	paddingRight: `${content.value.paddingRight ?? 24}px`,
	paddingBottom: `${content.value.paddingBottom ?? 16}px`,
	paddingLeft: `${content.value.paddingLeft ?? 24}px`,
	marginTop: `${content.value.marginTop ?? 0}px`,
	marginRight: `${content.value.marginRight ?? 0}px`,
	marginBottom: `${content.value.marginBottom ?? 0}px`,
	marginLeft: `${content.value.marginLeft ?? 0}px`,
}));

const enabledLinks = computed(() =>
	(content.value.links || []).filter((l) => l.enabled !== false)
);

const platformLabels: Record<string, string> = {
	twitter: 'X',
	facebook: 'Fb',
	instagram: 'Ig',
	linkedin: 'Li',
	youtube: 'Yt',
	tiktok: 'Tk',
	pinterest: 'Pi',
	github: 'Gh',
	threads: 'Th',
	bluesky: 'Bs',
	mastodon: 'Ma',
	discord: 'Dc',
};
</script>

<template>
	<div :style="wrapperStyles">
		<div
			class="inline-flex items-center"
			:style="{
				gap: `${content.iconSpacing || 12}px`,
				flexDirection: content.mode === 'vertical' ? 'column' : 'row',
			}"
		>
			<div
				v-for="link in enabledLinks"
				:key="link.platform"
				class="flex items-center justify-center rounded-full text-white font-bold text-xs"
				:style="{
					width: `${content.iconSize || 32}px`,
					height: `${content.iconSize || 32}px`,
					backgroundColor: content.iconColor || '#374151',
				}"
			>
				{{ platformLabels[link.platform] || link.platform.slice(0, 2).toUpperCase() }}
			</div>
		</div>
	</div>
</template>
