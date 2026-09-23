<script setup lang="ts">
import { inject } from 'vue';
/** Move the existing rail into the app sidebar at desktop widths. On smaller
 * screens the same component instance stays in its original drawer.
 *
 * Only Settings takes the sidebar over (it is a separate mode with its own
 * Back button). Daily-work rails — Mail's folders, chat's rooms, the
 * assistant's history — pass `inline` and stay in the page as their own
 * column, so the app sidebar never changes shape while you work. */
const props = defineProps<{ title: string; inline?: boolean }>();
const id = useId();
const isDesktopViewport = useMediaQuery('(min-width: 1024px)');
const { register, unregister } = useSectionNavigation();
const target = inject<Ref<HTMLElement | null>>('section-navigation-target', ref(null));
const mounted = ref(false);

onMounted(() => {
	mounted.value = true;
	watch(
		[isDesktopViewport, () => props.title, target],
		([desktop, title, element]) => {
			if (desktop && element && !props.inline) register(id, title);
			else unregister(id);
		},
		{ immediate: true }
	);
});
onBeforeUnmount(() => unregister(id));
</script>

<template>
	<Teleport
		:to="target ?? 'body'"
		:disabled="inline || !mounted || !isDesktopViewport || !target"
		defer
	>
		<slot />
	</Teleport>
</template>
