<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

// Pane 1's responsive shell: a static column at lg+, an off-canvas drawer below
// it (same pattern as the dashboard shell's mobile sidebar). The rail itself is
// unchanged — this only decides where it sits.
const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole: string;
	folderId?: Id<'mailFolders'>;
	open: boolean;
}>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

// Off-canvas is a transform, not an unmount, so the rail's links and controls
// would otherwise stay in the tab order and the accessibility tree while the
// drawer is closed. (The dashboard shell also inerts its sidebar, but only for
// the desktop auto-hide/focus-mode state — its mobile drawer is not covered, so
// this needs its own viewport check rather than the shell's condition.)
const isDesktopViewport = useMediaQuery('(min-width: 1024px)');
const isOffCanvas = computed(() => !isDesktopViewport.value && !props.open);
</script>

<template>
	<Transition
		enter-active-class="transition-opacity duration-(--motion-moderate)"
		enter-from-class="opacity-0"
		enter-to-class="opacity-100"
		leave-active-class="transition-opacity duration-(--motion-moderate-exit)"
		leave-from-class="opacity-100"
		leave-to-class="opacity-0"
	>
		<div
			v-if="open"
			class="fixed inset-0 bg-scrim/50 z-40 lg:hidden"
			@click="emit('update:open', false)"
		/>
	</Transition>

	<div
		class="fixed top-0 left-0 z-50 h-full flex transition-transform pt-[env(safe-area-inset-top)] lg:pt-0 lg:static lg:z-auto lg:h-auto lg:translate-x-0 lg:transition-none"
		:class="
			open
				? 'translate-x-0 duration-(--motion-moderate)'
				: '-translate-x-full duration-(--motion-moderate-exit)'
		"
		:inert="isOffCanvas ? true : undefined"
	>
		<!-- Below lg the rail IS the drawer: it was opened deliberately and there
		     is no adjacent content to make room for, so the saved collapsed
		     preference (a desktop space tradeoff) must not turn it into an icon
		     strip. At lg+ the drawer is a static column and the preference wins. -->
		<PostboxFolderRail
			:mailbox-id="mailboxId"
			:folder-role="folderRole"
			:folder-id="folderId"
			:force-expanded="!isDesktopViewport"
		/>
	</div>
</template>
