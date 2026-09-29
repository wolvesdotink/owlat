import { type Ref, type WatchSource, readonly, ref, watch } from 'vue';

/**
 * A flag that turns true the first time `source` is true and never turns back.
 *
 * For shell overlays that are rarely used but must keep working once used:
 * render them with `v-if` on this flag and they stay off the boot path until
 * first needed, then stay mounted, so closing one keeps its leave transition,
 * its focus restore and its already loaded chunk.
 */
export function useMountOnFirst(source: WatchSource<boolean>): Readonly<Ref<boolean>> {
	const mounted = ref(false);
	watch(
		source,
		(value) => {
			if (value) mounted.value = true;
		},
		{ immediate: true }
	);
	return readonly(mounted);
}
