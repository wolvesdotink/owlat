<script setup lang="ts">
import { inject } from 'vue';
/** Move the existing rail into the app sidebar at desktop widths. On smaller
 * screens the same component instance stays in its original drawer. */
const props = defineProps<{ title: string }>();
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
			if (desktop && element) register(id, title);
			else unregister(id);
		},
		{ immediate: true }
	);
});
onBeforeUnmount(() => unregister(id));
</script>

<template>
	<Teleport :to="target ?? 'body'" :disabled="!mounted || !isDesktopViewport || !target" defer>
		<slot />
	</Teleport>
</template>
