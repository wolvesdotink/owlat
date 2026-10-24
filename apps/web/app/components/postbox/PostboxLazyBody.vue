<script setup lang="ts">
/**
 * Holds a reader message's body back until it scrolls near the viewport (see
 * usePostboxLazyBody). Until then it renders an empty block of the body's
 * last measured frame height from the render cache, so the thread does not
 * jump when the real body replaces it.
 *
 * The body renders untrusted mail, so once mounted it sits in its own
 * boundary: a body that fails to render takes down only itself, not the rest
 * of the conversation.
 */
import {
	POSTBOX_BODY_PLACEHOLDER_PX,
	usePostboxLazyBody,
} from '~/composables/postbox/usePostboxLazyBody';
import { getPostboxRenderCache } from '~/utils/postboxRenderCache';
import { useReadingComfort } from '~/composables/useReadingComfort';
import { postboxImagesLoadOnOpen, type PostboxBodyImageProps } from '~/utils/postboxImageAllowlist';

const props = defineProps<{
	messageId: string;
	/** Same inputs PostboxMessageBody starts its first render with. */
	forceLight: boolean;
	images: PostboxBodyImageProps;
	/** Mount now, wherever the body sits (printing). */
	eager?: boolean;
}>();

const { isDark } = useAppTheme();
const { mailTypography } = useReadingComfort();

const placeholderEl = ref<HTMLElement | null>(null);
const { mounted } = usePostboxLazyBody({ target: placeholderEl, eager: () => !!props.eager });

// Read once per placeholder: the cache is not reactive, and the height only
// matters until the body mounts.
const placeholderHeight = computed(
	() =>
		getPostboxRenderCache().heightFor(props.messageId, {
			scheme: isDark.value && !props.forceLight ? 'dark' : 'light',
			showImages: postboxImagesLoadOnOpen(props.images),
			loadEverything: false,
			showQuoted: false,
			typography: mailTypography.value,
		}) ?? POSTBOX_BODY_PLACEHOLDER_PX
);
</script>

<template>
	<AppErrorBoundary v-if="mounted" surface="messageBody" :reset-keys="[messageId]">
		<slot />
	</AppErrorBoundary>
	<div
		v-else
		ref="placeholderEl"
		class="mt-4"
		data-testid="postbox-lazy-body"
		aria-hidden="true"
		:style="{ height: `${placeholderHeight}px` }"
	/>
</template>
