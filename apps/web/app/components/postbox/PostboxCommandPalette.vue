<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { usePostboxPaletteMounted } from '~/lib/globalSwitcher';

/**
 * Cmd/Ctrl-K command palette for Postbox. Also consumes the desktop shell's
 * `owlat:quick-switcher` event (previously dispatched into the void). Filterable
 * command list with arrow-key navigation; Enter runs, Escape closes.
 *
 * While mounted it bumps a shared counter so the header `GlobalSearch` knows a
 * palette is present and defers the global shortcut to it (see globalSwitcher).
 */
const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
}>();

const stack = usePostboxComposerStack();
const { isDesktop } = useDesktopContext();
const paletteMounted = usePostboxPaletteMounted();

const open = ref(false);
const query = ref('');
const activeIndex = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);

interface Command {
	id: string;
	label: string;
	hint?: string;
	icon: string;
	run: () => void;
}

const commands = computed<Command[]>(() => [
	{ id: 'compose', label: 'Compose new message', icon: 'lucide:pencil', hint: 'c', run: () => stack.open({ mailboxId: props.mailboxId }) },
	{ id: 'inbox', label: 'Go to Inbox', icon: 'lucide:inbox', run: () => navigateTo('/dashboard/postbox/inbox') },
	{ id: 'sent', label: 'Go to Sent', icon: 'lucide:send', run: () => navigateTo('/dashboard/postbox/sent') },
	{ id: 'drafts', label: 'Go to Drafts', icon: 'lucide:file-edit', run: () => navigateTo('/dashboard/postbox/drafts') },
	{ id: 'archive', label: 'Go to Archive', icon: 'lucide:archive', run: () => navigateTo('/dashboard/postbox/archive') },
	{ id: 'spam', label: 'Go to Spam', icon: 'lucide:shield-alert', run: () => navigateTo('/dashboard/postbox/spam') },
	{ id: 'trash', label: 'Go to Trash', icon: 'lucide:trash', run: () => navigateTo('/dashboard/postbox/trash') },
	{ id: 'snoozed', label: 'Go to Snoozed', icon: 'lucide:clock', run: () => navigateTo('/dashboard/postbox/snoozed') },
	{ id: 'contacts', label: 'Go to Contacts', icon: 'lucide:users', run: () => navigateTo('/dashboard/postbox/contacts') },
	{ id: 'search', label: 'Search mail', icon: 'lucide:search', hint: '/', run: () => navigateTo('/dashboard/postbox/search') },
	{ id: 'settings', label: 'Mail settings', icon: 'lucide:settings', run: () => navigateTo('/dashboard/postbox/settings') },
	...(isDesktop.value
		? [
				{
					id: 'update',
					label: 'Check for updates',
					icon: 'lucide:download-cloud',
					run: () => window.dispatchEvent(new Event('owlat:check-updates')),
				},
			]
		: []),
]);

const filtered = computed(() => {
	const q = query.value.trim().toLowerCase();
	if (!q) return commands.value;
	return commands.value.filter((c) => c.label.toLowerCase().includes(q));
});

watch(filtered, () => {
	activeIndex.value = 0;
});

async function openPalette() {
	open.value = true;
	query.value = '';
	activeIndex.value = 0;
	await nextTick();
	inputEl.value?.focus();
}

function close() {
	open.value = false;
}

function runCommand(cmd: Command | undefined) {
	if (!cmd) return;
	close();
	cmd.run();
}

function onInputKeydown(event: KeyboardEvent) {
	if (event.key === 'Escape') {
		event.preventDefault();
		close();
		return;
	}
	if (event.key === 'ArrowDown') {
		event.preventDefault();
		activeIndex.value = Math.min(activeIndex.value + 1, filtered.value.length - 1);
	} else if (event.key === 'ArrowUp') {
		event.preventDefault();
		activeIndex.value = Math.max(activeIndex.value - 1, 0);
	} else if (event.key === 'Enter') {
		event.preventDefault();
		runCommand(filtered.value[activeIndex.value]);
	}
}

function onGlobalKey(event: KeyboardEvent) {
	// Plain Cmd+K only — Cmd+Shift+K is the Quick Query shortcut (dashboard layout).
	if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
		event.preventDefault();
		if (open.value) close();
		else void openPalette();
	}
}

function onQuickSwitcher() {
	void openPalette();
}

onMounted(() => {
	paletteMounted.value++;
	window.addEventListener('keydown', onGlobalKey);
	window.addEventListener('owlat:quick-switcher', onQuickSwitcher);
});
onBeforeUnmount(() => {
	paletteMounted.value = Math.max(0, paletteMounted.value - 1);
	window.removeEventListener('keydown', onGlobalKey);
	window.removeEventListener('owlat:quick-switcher', onQuickSwitcher);
});
</script>

<template>
	<UiModal :open="open" aria-label="Command palette" :closable="false" @update:open="(v) => { if (!v) close(); }">
		<!-- Escape at the dialog level so it works even after focus leaves the input. -->
		<div @keydown.esc.prevent="close">
		<div class="flex items-center gap-2 border-b border-border-subtle pb-2 mb-2">
			<Icon name="lucide:search" class="w-4 h-4 text-text-tertiary" />
			<input
				ref="inputEl"
				v-model="query"
				type="text"
				placeholder="Type a command…"
				class="flex-1 bg-transparent outline-none text-sm"
				role="combobox"
				aria-expanded="true"
				aria-controls="postbox-cmdk-list"
				:aria-activedescendant="filtered[activeIndex] ? `postbox-cmdk-opt-${activeIndex}` : undefined"
				aria-label="Command palette"
				@keydown="onInputKeydown"
			>
			<kbd class="text-[10px] text-text-tertiary border border-border-subtle rounded px-1">esc</kbd>
		</div>
		<ul id="postbox-cmdk-list" role="listbox" class="max-h-80 overflow-auto -mx-2">
			<li v-for="(cmd, i) in filtered" :key="cmd.id">
				<button
					:id="`postbox-cmdk-opt-${i}`"
					type="button"
					role="option"
					:aria-selected="i === activeIndex"
					class="w-full flex items-center gap-3 px-3 py-2 rounded text-left text-sm"
					:class="i === activeIndex ? 'bg-bg-surface text-text-primary' : 'hover:bg-bg-surface text-text-secondary'"
					@click="runCommand(cmd)"
					@mousemove="activeIndex = i"
				>
					<Icon :name="cmd.icon" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
					<span class="flex-1">{{ cmd.label }}</span>
					<kbd
						v-if="cmd.hint"
						class="text-[10px] text-text-tertiary border border-border-subtle rounded px-1"
					>{{ cmd.hint }}</kbd>
				</button>
			</li>
			<li v-if="filtered.length === 0" class="px-3 py-6 text-center text-sm text-text-tertiary">
				No matching commands
			</li>
		</ul>
		</div>
	</UiModal>
</template>
