<script setup lang="ts">
/**
 * "?" keyboard cheat-sheet overlay: a single dialog listing all Postbox
 * shortcuts grouped by area (data lives in utils/postboxShortcuts.ts).
 *
 * Self-contained: mounting it registers a window-level "?" toggle (inert
 * while focus is in an input/contenteditable), and Esc closes via the shared
 * modal focus handling. Mounted by PostboxLayout and the search screen.
 */

const open = useState('postbox:shortcut-help', () => false);

function onGlobalKey(event: KeyboardEvent) {
	if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	event.preventDefault();
	open.value = !open.value;
}

onMounted(() => window.addEventListener('keydown', onGlobalKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey));
</script>

<template>
	<UiModal :open="open" title="Keyboard shortcuts" size="lg" @update:open="open = $event">
		<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6">
			<section v-for="group in POSTBOX_SHORTCUT_GROUPS" :key="group.title">
				<h3 class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
					{{ group.title }}
				</h3>
				<ul class="space-y-1.5">
					<li
						v-for="shortcut in group.shortcuts"
						:key="shortcut.label"
						class="flex items-center justify-between gap-4 text-sm"
					>
						<span class="text-text-secondary">{{ shortcut.label }}</span>
						<span class="flex items-center gap-1 flex-shrink-0">
							<kbd
								v-for="k in shortcut.keys"
								:key="k"
								class="px-1.5 py-0.5 rounded border border-border-subtle bg-bg-surface text-xs font-mono text-text-primary"
							>{{ k }}</kbd>
						</span>
					</li>
				</ul>
			</section>
		</div>
	</UiModal>
</template>
