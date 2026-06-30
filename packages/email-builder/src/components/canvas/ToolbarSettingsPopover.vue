<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import type { EditorBlock, Variable, EmailTheme } from '../../types';
import type { BlockAttributeSchema, PropertyGroup as PropertyGroupType } from '../../schema/types';
import PropertyGroup from '../panel/PropertyGroup.vue';
import { X } from '@lucide/vue';
import IconButton from '../ui/IconButton.vue';

const props = defineProps<{
	block: EditorBlock;
	schema: BlockAttributeSchema;
	theme: Required<EmailTheme>;
	variables?: Variable[];
	onUploadImage?: (file: File) => Promise<{ url: string; storageId?: string }>;
	anchorElement: HTMLElement;
	/** When provided, render only this single group instead of all schema groups */
	group?: PropertyGroupType;
}>();

const groups = computed(() => props.group ? [props.group] : props.schema.groups);
const title = computed(() => props.group ? props.group.label : props.schema.label);

const emit = defineEmits<{
	(e: 'update', key: string, value: unknown): void;
	(e: 'close'): void;
}>();

const popoverEl = ref<HTMLElement | null>(null);
const popoverStyle = ref<Record<string, string>>({});

function updatePosition() {
	if (!props.anchorElement || !popoverEl.value) return;
	const anchorRect = props.anchorElement.getBoundingClientRect();
	const popoverRect = popoverEl.value.getBoundingClientRect();

	let top = anchorRect.bottom + 8;
	let left = anchorRect.right - popoverRect.width;

	// Keep within viewport
	if (left < 8) left = 8;
	if (top + popoverRect.height > window.innerHeight - 8) {
		top = anchorRect.top - popoverRect.height - 8;
	}

	popoverStyle.value = {
		top: `${top}px`,
		left: `${left}px`,
	};
}

function handleClickOutside(event: MouseEvent) {
	if (!popoverEl.value) return;
	const target = event.target as HTMLElement;
	// Ignore clicks inside the popover or its anchor (the toolbar)
	if (popoverEl.value.contains(target) || props.anchorElement.contains(target)) {
		return;
	}
	// Ignore clicks inside modals (e.g. media picker) that are teleported to body
	if (target.closest('[role="dialog"]')) {
		return;
	}
	emit('close');
}

onMounted(() => {
	nextTick(() => {
		updatePosition();
	});
	document.addEventListener('mousedown', handleClickOutside, true);
	window.addEventListener('resize', updatePosition);
	window.addEventListener('scroll', updatePosition, true);
});

onUnmounted(() => {
	document.removeEventListener('mousedown', handleClickOutside, true);
	window.removeEventListener('resize', updatePosition);
	window.removeEventListener('scroll', updatePosition, true);
});
</script>

<template>
	<Teleport to="body">
		<div
			ref="popoverEl"
			role="dialog"
			aria-labelledby="toolbar-settings-title"
			class="light fixed z-[1001] w-[320px] max-h-[400px] flex flex-col bg-bg-elevated/96 backdrop-blur-overlay-heavy border border-border-subtle rounded-xl shadow-popover animate-eb-popover-enter"
			:style="popoverStyle"
			@mousedown.stop
		>
			<div class="flex items-center justify-between py-2.5 px-3 border-b border-border-subtle shrink-0">
				<span id="toolbar-settings-title" class="text-xs font-semibold uppercase tracking-[0.05em] text-text-secondary">{{ title }}</span>
				<IconButton :icon="X" title="Close" aria-label="Close" size="sm" @click="emit('close')" />
			</div>

			<div class="overflow-y-auto scrollbar-thin-overlay">
				<PropertyGroup
					v-for="g in groups"
					:key="g.label"
					:group="g"
					:block="block"
					:theme="theme"
					:variables="variables"
					:on-upload-image="onUploadImage"
					:hide-header="!!group"
					@update="(key, value) => emit('update', key, value)"
				/>
			</div>
		</div>
	</Teleport>
</template>

