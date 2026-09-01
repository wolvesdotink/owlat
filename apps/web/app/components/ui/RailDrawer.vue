<script setup lang="ts">
/**
 * A left rail that is a static column at `md` and an off-canvas drawer below it.
 *
 * Same shape as PostboxFolderDrawer (which is pinned to `lg` because Postbox has
 * three panes to fit); this one exists because chat and the assistant used to
 * `hidden md:block` their conversation rail, which on a phone deleted the room
 * list and — in the assistant's case — the only "New chat" button with it.
 *
 * The rail itself is whatever the caller slots in: this only decides where it
 * sits. The slotted rail paints its own background, because below `md` it floats
 * over the thread rather than sitting beside it.
 */
// Two roots (scrim + panel), so attributes have to be routed by hand: `id` and
// friends belong on the panel the handle's `aria-controls` points at, not on the
// scrim that only exists while the drawer is open.
defineOptions({ inheritAttrs: false });

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const close = () => emit('update:open', false);

// Off-canvas is a transform, not an unmount, so without `inert` a phone user
// tabs through every conversation in a pane they cannot see.
const isDesktopViewport = useMediaQuery('(min-width: 768px)');
const isOffCanvas = computed(() => !isDesktopViewport.value && !props.open);

// The phone's bottom tab bar outranks this drawer (z-(--z-header) beats the
// panel's z-50 and the scrim's z-40), so it has to step aside exactly as it
// does for the shell's own navigation drawer. The shell hands that one down as
// a prop; this state lives in the page, so it goes through shared state
// instead. Only while the rail is an overlay: at `md` it is a plain column and
// the bar (which runs to `lg`) sits beside it, not over it.
const { setOpen: setRailDrawerOpen } = useRailDrawer();
const isOverlay = computed(() => !isDesktopViewport.value && props.open);
watch(isOverlay, setRailDrawerOpen, { immediate: true });
onUnmounted(() => {
	if (isOverlay.value) setRailDrawerOpen(false);
});
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
		<div v-if="open" class="fixed inset-0 bg-scrim/50 z-40 md:hidden" @click="close" />
	</Transition>

	<div
		v-bind="$attrs"
		class="fixed top-0 left-0 z-50 h-full w-72 flex-shrink-0 flex transition-transform pt-[env(safe-area-inset-top)] md:pt-0 md:static md:z-auto md:h-auto md:translate-x-0 md:transition-none"
		:class="
			open
				? 'translate-x-0 duration-(--motion-moderate)'
				: '-translate-x-full duration-(--motion-moderate-exit)'
		"
		:inert="isOffCanvas ? true : undefined"
		@keydown.esc="close"
	>
		<slot />
	</div>
</template>
