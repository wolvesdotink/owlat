<script setup lang="ts">
/**
 * The app-wide "?" cheat sheet.
 *
 * Both the list and its grouping are GENERATED from the one shortcut registry
 * (`utils/shortcutCatalog.ts`). This component used to hand-maintain a parallel
 * copy, and it had drifted: it advertised chords the dispatcher no longer had
 * and omitted ones it did. Now a shortcut is documented by existing.
 *
 * It renders the scopes that are live at the moment it opens, so a surface
 * which has claimed the keyboard (the Postbox) shows its own chords rather than
 * the globals they shadow — in practice the Postbox ships its own richer sheet
 * and claims "?" outright (utils/helpOverlayOwnership.ts), so this one is the
 * app-wide map.
 *
 * On UiModal for the shared focus trap, opener restore and Escape handling
 * (packages/ui `useModalFocus`), instead of a second hand-rolled dialog.
 */
import { buildShortcutSheet, shortcutSheetKeys } from '~/utils/shortcutRegistry';
import { SHORTCUT_CATALOG } from '~/utils/shortcutCatalog';
import { activeShortcutScopes, shortcutBindings } from '~/utils/shortcutScope';

const { t } = useI18n();
const { isHelpModalOpen, closeHelpModal } = useKeyboardShortcuts();

// A browser on a Mac wants the ⌘ hint even though it is not the desktop app.
const { platform } = useDesktopContext();
const isMac = computed(() => import.meta.client && platform.value === 'mac');

// Recomputed while open: the scope chain changes with the route, and the
// bindings change when the user picks a preset or remaps a key.
const groups = computed(() =>
	isHelpModalOpen.value
		? buildShortcutSheet(SHORTCUT_CATALOG, shortcutBindings.value, {
				scopes: activeShortcutScopes(),
				isMac: isMac.value,
			})
		: []
);
</script>

<template>
	<UiModal
		:open="isHelpModalOpen"
		:title="t('components.keyboardShortcutsHelp.title')"
		size="lg"
		@update:open="closeHelpModal()"
	>
		<p class="text-sm text-text-tertiary -mt-2 mb-4">
			{{ t('components.keyboardShortcutsHelp.subtitle') }}
		</p>

		<div class="max-h-[60vh] overflow-y-auto space-y-6">
			<section v-for="group in groups" :key="group.groupKey">
				<h3 class="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-3">
					{{ t(group.groupKey) }}
				</h3>
				<ul class="space-y-2">
					<li
						v-for="item in group.items"
						:key="item.id"
						class="flex items-center justify-between gap-4 py-1.5 text-sm"
					>
						<span class="text-text-secondary">{{ t(item.labelKey) }}</span>
						<span class="flex items-center gap-1 flex-shrink-0">
							<kbd
								v-for="(key, index) in shortcutSheetKeys(item)"
								:key="index"
								class="px-2 py-1 text-xs font-medium text-text-tertiary bg-bg-surface border border-border-subtle rounded"
								>{{ key }}</kbd
							>
						</span>
					</li>
				</ul>
			</section>
		</div>

		<template #footer>
			<p class="w-full text-xs text-text-tertiary text-center">
				<I18nT keypath="components.keyboardShortcutsHelp.footer" tag="span" scope="global">
					<template #key>
						<kbd
							class="px-1.5 py-0.5 text-[10px] font-medium bg-bg-elevated border border-border-subtle rounded mx-1"
							>?</kbd
						>
					</template>
				</I18nT>
			</p>
		</template>
	</UiModal>
</template>
