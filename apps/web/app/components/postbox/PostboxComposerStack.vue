<script setup lang="ts">
import { layoutComposerStack } from '~/utils/postboxComposerLayout';

const { state } = usePostboxComposerStack();

const placement = computed(() => layoutComposerStack(state.value));

// Floating popups, each with its right-to-left slot; the docked composers roll
// up into the bottom dock so nothing marches offscreen once 3+ are open.
const popups = computed(() =>
	placement.value.popups
		.map((p) => {
			const spec = state.value.find((c) => c.id === p.id);
			return spec ? { spec, slot: p.slot } : null;
		})
		.filter((p): p is { spec: (typeof state.value)[number]; slot: number } => p !== null)
);

const dockComposers = computed(() =>
	placement.value.dock
		.map((d) => state.value.find((c) => c.id === d.id))
		.filter((c): c is (typeof state.value)[number] => c !== undefined)
);
</script>

<template>
	<Teleport to="body">
		<!-- Focus surface first so its teleport target (#pbx-focus-mount) exists
		     before any popup promotes into it. -->
		<PostboxComposerFocusSurface />
		<PostboxComposerPopup
			v-for="{ spec, slot } in popups"
			:key="spec.id"
			:composer="spec"
			:slot-index="slot"
		/>
		<PostboxComposerDock :composers="dockComposers" />
		<PostboxUndoSendToast />
	</Teleport>
</template>
