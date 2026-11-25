<script setup lang="ts">
/**
 * The content of an email the translation table cannot translate, which every
 * language sends as the default language has it.
 */
import type { SharedContentKind } from '~/utils/translationRows';

defineProps<{ kinds: SharedContentKind[] }>();

const { t } = useI18n();

const KIND_KEYS: Record<SharedContentKind, string> = {
	links: 'components.translation.manager.sharedLinks',
	images: 'components.translation.manager.sharedImages',
	rawHtml: 'components.translation.manager.sharedRawHtml',
	video: 'components.translation.manager.sharedVideo',
	carousel: 'components.translation.manager.sharedCarousel',
};
</script>

<template>
	<div v-if="kinds.length > 0" class="mt-6 p-4 rounded-xl surface-3 text-sm">
		<p class="text-text-primary font-medium mb-1">
			{{ t('components.translation.manager.sharedTitle') }}
		</p>
		<ul class="list-disc pl-5 text-text-secondary">
			<li v-for="kind in kinds" :key="kind">{{ t(KIND_KEYS[kind]) }}</li>
		</ul>
	</div>
</template>
