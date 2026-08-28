<script setup lang="ts">
/**
 * "?" keyboard cheat-sheet overlay: a single dialog listing all Postbox
 * shortcuts grouped by area.
 *
 * The list is GENERATED from the one shortcut registry (utils/shortcutCatalog
 * via `postboxShortcutSheet`), so it shows the chords this user actually has —
 * their preset, their remaps — instead of a hand-kept copy that drifts from the
 * resolver it claims to document.
 *
 * Self-contained: mounting it registers a window-level "?" toggle (inert
 * while focus is in an input/contenteditable), claims the `postbox` scope for
 * the registry, and Esc closes via the shared modal focus handling. Mounted by
 * PostboxLayout, the label page and the search screen.
 *
 * Mounting also CLAIMS "?" for this sheet, which silences the app-wide cheat
 * sheet's own document listener for as long as this one is on screen — both
 * used to answer the same press and stack two overlays.
 */
import { claimHelpOverlay } from '~/utils/helpOverlayOwnership';
import { postboxShortcutSheet } from '~/utils/postboxShortcuts';
import { shortcutSheetKeys } from '~/utils/shortcutRegistry';

const { t } = useI18n();

// Not `useDesktopContext().isMac`: that one is gated on the desktop RUNTIME,
// and a browser on a Mac still wants the ⌘ hint.
const { platform } = useDesktopContext();
const isMac = computed(() => import.meta.client && platform.value === 'mac');

// `postbox` chords first, then the composer's — the keys a person reaches for
// straight after `r`, and the only place they are taught.
const groups = computed(() => postboxShortcutSheet(isMac.value));

// Claims the registry scope and binds the mailbox `g` chords for as long as
// any Postbox surface is mounted.
usePostboxShortcutScope();

const open = useState('postbox:shortcut-help', () => false);

function onGlobalKey(event: KeyboardEvent) {
	if (event.key !== '?' || event.metaKey || event.ctrlKey || event.altKey) return;
	if (isEditableTarget(event.target)) return;
	event.preventDefault();
	open.value = !open.value;
}

let releaseClaim: (() => void) | null = null;
onMounted(() => {
	releaseClaim = claimHelpOverlay();
	window.addEventListener('keydown', onGlobalKey);
});
onBeforeUnmount(() => {
	releaseClaim?.();
	releaseClaim = null;
	window.removeEventListener('keydown', onGlobalKey);
});
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.postbox.postboxShortcutHelp.title')"
		size="lg"
		@update:open="open = $event"
	>
		<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-6">
			<section v-for="group in groups" :key="group.groupKey">
				<h3 class="text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
					{{ t(group.groupKey) }}
				</h3>
				<ul class="space-y-1.5">
					<li
						v-for="item in group.items"
						:key="item.id"
						class="flex items-center justify-between gap-4 text-sm"
					>
						<span class="text-text-secondary">{{ t(item.labelKey) }}</span>
						<span class="flex items-center gap-1 flex-shrink-0">
							<kbd
								v-for="(k, index) in shortcutSheetKeys(item)"
								:key="index"
								class="px-1.5 py-0.5 rounded border border-border-subtle bg-bg-surface text-xs font-mono text-text-primary"
								>{{ k }}</kbd
							>
						</span>
					</li>
				</ul>
			</section>
		</div>
	</UiModal>
</template>
