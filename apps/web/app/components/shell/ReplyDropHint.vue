<script setup lang="ts">
/**
 * The hint over a conversation that a file drag would reply to ("Drop to
 * reply to Ines with 2 files"), drawn over the row or the reader the pointer
 * is on. One per app, in the dashboard shell, which also makes it the host
 * that turns the drop into Answer mode with the files attached
 * (useReplyDropHost).
 *
 * It never takes the pointer: the drag events keep landing on the
 * conversation under it. It is hidden from assistive tech because the gesture
 * is a pointer one; the composer's own attach button is the accessible path.
 */
import { useReplyDropHost } from '~/composables/useReplyFileDrop';

const { t } = useI18n();
const { hover } = useReplyDropHost();

const label = computed(() => {
	const shown = hover.value;
	if (!shown) return '';
	const name = shown.target.recipient;
	const count = shown.count;
	if (count === null) {
		return name
			? t('components.shell.replyDrop.hintNoCount', { name })
			: t('components.shell.replyDrop.hintNoNameNoCount');
	}
	return name
		? t('components.shell.replyDrop.hint', { name, count }, count)
		: t('components.shell.replyDrop.hintNoName', { count }, count);
});

const box = computed(() => {
	const rect = hover.value?.rect;
	return rect
		? {
				top: `${rect.top}px`,
				left: `${rect.left}px`,
				width: `${rect.width}px`,
				height: `${rect.height}px`,
			}
		: undefined;
});
</script>

<template>
	<Teleport to="body">
		<div
			v-if="hover"
			class="pointer-events-none fixed z-50 flex items-center justify-center rounded-md border-2 border-dashed border-brand bg-bg-base/80 p-2"
			:style="box"
			aria-hidden="true"
			data-testid="reply-drop-hint"
		>
			<span
				class="flex max-w-full items-center gap-1.5 truncate rounded-full border border-border-subtle bg-bg-elevated px-3 py-1 text-xs font-medium text-text-primary shadow-(--shadow-1)"
			>
				<Icon name="lucide:reply" class="size-3.5 shrink-0 text-brand" />
				<span class="truncate">{{ label }}</span>
			</span>
		</div>
	</Teleport>
</template>
