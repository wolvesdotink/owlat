<script setup lang="ts">
/**
 * A chat room while it loads: the `ChatRoomHeader` bar (optional) over a run of
 * message rows at `ChatMessage`'s geometry (36px avatar, name and time line,
 * one or two lines of text), in place of a spinner centred in an empty pane.
 * The composer and member panel mount with the real room, so only the parts
 * that are waiting on the query are drawn here.
 *
 * Held back for 150 ms (`useDelayedLoading`) while keeping its box, so a room
 * that is already in the subscription cache opens without a placeholder frame.
 */
import { useDelayedLoading } from '@owlat/ui/composables/useDelayedLoading';

withDefaults(
	defineProps<{
		/** Draw the room header bar too (the whole room is loading). */
		header?: boolean;
		/** Message rows to draw. */
		rows?: number;
	}>(),
	{ header: true, rows: 5 }
);

const { t } = useI18n();
const visible = useDelayedLoading(true, { minVisible: 0 });

/** Ragged name and text widths, stable across re-renders. */
const NAME_WIDTHS = ['w-24', 'w-32', 'w-20', 'w-28'];
const TEXT_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-5/6'];
const pick = (list: string[], row: number) => list[(row - 1) % list.length];
</script>

<template>
	<div data-testid="chat-room-skeleton" class="flex-1 flex flex-col min-h-0" aria-busy="true">
		<p role="status" class="sr-only">{{ t('common.loading') }}</p>
		<div aria-hidden="true" class="flex-1 flex flex-col min-h-0" :class="{ invisible: !visible }">
			<div
				v-if="header"
				class="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-bg-elevated"
			>
				<UiSkeleton class="size-5 shrink-0" />
				<div class="flex-1 min-w-0">
					<UiSkeleton class="h-4 w-40" />
					<UiSkeleton class="mt-1.5 h-3 w-24" />
				</div>
				<UiSkeleton class="h-8 w-20 shrink-0" />
			</div>

			<!-- Newest at the bottom, as the list opens there. -->
			<div class="flex-1 flex flex-col justify-end overflow-hidden px-4 py-4 space-y-3">
				<div v-for="row in rows" :key="row" class="flex gap-3 px-2 py-1">
					<UiSkeleton circle class="size-9 shrink-0" />
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<UiSkeleton class="h-3.5" :class="pick(NAME_WIDTHS, row)" />
							<UiSkeleton class="h-3 w-10" />
						</div>
						<UiSkeleton class="mt-2 h-3.5" :class="pick(TEXT_WIDTHS, row)" />
						<UiSkeleton v-if="row % 2 === 0" class="mt-1.5 h-3.5 w-1/3" />
					</div>
				</div>
			</div>
		</div>
	</div>
</template>
