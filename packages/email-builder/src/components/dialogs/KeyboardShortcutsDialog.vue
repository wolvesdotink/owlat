<script setup lang="ts">
import { computed } from 'vue';
import UiModal from '@owlat/ui/components/ui/Modal.vue';
import {
	EDITOR_SHORTCUTS,
	EDITOR_SHORTCUT_GROUPS,
	formatShortcutKeys,
	useApplePlatform,
} from '../../composables/editorShortcuts';

defineProps<{
	show: boolean;
}>();

const emit = defineEmits<{
	(e: 'close'): void;
}>();

// Post-mount platform ref, so the server and the first client render agree on
// the modifier chip (⌘ vs Ctrl) instead of tripping a hydration mismatch.
const isApplePlatform = useApplePlatform();

const sections = computed(() =>
	EDITOR_SHORTCUT_GROUPS.map((group) => ({
		group,
		shortcuts: EDITOR_SHORTCUTS.filter((shortcut) => shortcut.group === group).map(
			(shortcut) => ({
				...shortcut,
				keys: formatShortcutKeys(shortcut.keys, isApplePlatform.value),
			})
		),
	})).filter((section) => section.shortcuts.length > 0)
);
</script>

<template>
	<UiModal :open="show" title="Keyboard Shortcuts" size="lg" @update:open="emit('close')">
		<div class="flex flex-col gap-5">
			<section v-for="section in sections" :key="section.group" class="flex flex-col gap-2">
				<h3 class="text-[10px] font-semibold uppercase tracking-[0.08em] text-text-tertiary m-0">
					{{ section.group }}
				</h3>
				<div
					v-for="shortcut in section.shortcuts"
					:key="shortcut.description"
					class="flex items-center justify-between gap-4"
				>
					<span class="text-[13px] text-text-secondary">{{ shortcut.description }}</span>
					<span class="flex items-center gap-1 shrink-0">
						<kbd
							v-for="key in shortcut.keys"
							:key="key"
							class="inline-block py-0.5 px-[7px] rounded bg-bg-surface text-text-primary font-mono text-[11px] font-medium border border-border-subtle"
							>{{ key }}</kbd
						>
					</span>
				</div>
			</section>
		</div>
	</UiModal>
</template>
