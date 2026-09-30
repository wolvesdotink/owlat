<script setup lang="ts">
import { useMediaQuery } from '~/composables/useMediaQuery';
import {
	COMPOSER_SHEET_QUERY,
	layoutComposerStack,
	SMALL_SCREEN_MAX_POPUPS,
} from '~/utils/postboxComposerLayout';

const { state } = usePostboxComposerStack();

// A phone has room for one composer, as a full-width sheet; the others dock.
const isSmallScreen = useMediaQuery(COMPOSER_SHEET_QUERY);
const placement = computed(() =>
	layoutComposerStack(state.value, isSmallScreen.value ? SMALL_SCREEN_MAX_POPUPS : undefined)
);

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
	// Under a phone's sheet the dock's chips would sit on its footer, over
	// Send; they come back once the sheet is minimised.
	isSmallScreen.value && popups.value.length > 0
		? []
		: placement.value.dock
				.map((d) => state.value.find((c) => c.id === d.id))
				.filter((c): c is (typeof state.value)[number] => c !== undefined)
);
</script>

<template>
	<Teleport to="body">
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
