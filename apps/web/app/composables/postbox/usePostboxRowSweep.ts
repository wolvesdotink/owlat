/**
 * A Postbox row's side of a sweep. The checkbox reads as it will once the
 * sweep covering the row is released, and a press on a sweep handle (the
 * checkbox or the Archive button, utils/postboxSweep.ts) starts a sweep while
 * the row's own swipe still sees the press and its native drag is refused.
 */
import { computed } from 'vue';
import { createPostboxSweepHandle, type PostboxSweepMark } from '~/utils/postboxSweep';

interface PostboxRowSweepEmit {
	(event: 'sweep-start', kind: 'select' | 'archive', pointer: PointerEvent): void;
	(event: 'drag-start', drag: DragEvent): void;
}

export function usePostboxRowSweep(
	row: { readonly sweepMark?: PostboxSweepMark | null; readonly selected: boolean },
	emit: PostboxRowSweepEmit,
	gestures: { onPointerdown: (event: PointerEvent) => void }
) {
	const shownSelected = computed(() =>
		row.sweepMark === 'select' ? true : row.sweepMark === 'deselect' ? false : row.selected
	);
	const handle = createPostboxSweepHandle((kind, event) => emit('sweep-start', kind, event));
	return {
		shownSelected,
		onRowPointerdown(event: PointerEvent) {
			handle.onPointerdown(event);
			gestures.onPointerdown(event);
		},
		onDragstart(event: DragEvent) {
			if (!handle.claimsDrag(event)) emit('drag-start', event);
		},
	};
}
