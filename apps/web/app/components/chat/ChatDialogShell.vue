<script setup lang="ts">
/**
 * Shared shell for the chat dialogs (new channel / new DM / link email /
 * channel browser) — overlay, panel, header, close button. The four dialogs
 * carried byte-identical copies of this markup before. Body goes in the
 * default slot; Escape and overlay-click both close.
 */
import { CloseIcon } from '@coolicons/vue';

const { t } = useI18n();

defineProps<{
	/** Already-translated heading — every caller passes it through `t()`. */
	title: string;
	/** Panel width: 'md' for forms, 'lg' for scrollable browsers. */
	size?: 'md' | 'lg';
}>();

const emit = defineEmits<{ close: [] }>();

const titleId = useId();
const panelRef = ref<HTMLElement | null>(null);
// Focus trap + opener restore + Escape, shared with UiModal.
useModalFocus(
	panelRef,
	() => true,
	() => emit('close')
);
</script>

<template>
	<Teleport to="body">
		<div
			class="fixed inset-0 z-(--z-modal) flex items-center justify-center p-4 bg-scrim/50"
			@click.self="emit('close')"
		>
			<div
				ref="panelRef"
				role="dialog"
				aria-modal="true"
				:aria-labelledby="titleId"
				tabindex="-1"
				:class="[
					'w-full flex flex-col max-h-[85dvh] bg-bg-elevated border border-border-subtle rounded-xl shadow-xl',
					// A form dialog scrolls as a whole, so its footer stays reachable
					// above a phone keyboard; the browser owns its list's scrolling.
					size === 'lg' ? 'max-w-lg' : 'max-w-md overflow-y-auto',
				]"
			>
				<div class="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
					<h3 :id="titleId" class="text-base font-semibold text-text-primary">{{ title }}</h3>
					<UiButton
						variant="ghost"
						size="sm"
						class="w-8 px-0"
						:aria-label="t('common.close')"
						@click="emit('close')"
					>
						<CloseIcon class="w-4 h-4" />
					</UiButton>
				</div>

				<slot />
			</div>
		</div>
	</Teleport>
</template>
