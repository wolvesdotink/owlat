<script setup lang="ts">
import { resolveActiveChord, shortcutBindings } from '~/utils/shortcutScope';
import { formatChord } from '~/utils/shortcutRegistry';
import { isEditableTarget } from '~/utils/postboxShortcuts';
import { isDialogOpen } from '~/utils/dialogOpen';

/**
 * The bar above an open conversation when the list is not beside it.
 *
 * Below lg it is the drill-in "← Inbox" (the only way out of the reader there;
 * py-3 puts the full-width bar past the 44px touch target). In Zen mode, where
 * the reader is the whole screen at every width, it also carries previous and
 * next, and j/k walk the folder the way they walk the list, so reading one
 * conversation after another never needs the list back.
 */
const props = defineProps<{
	folderName: string;
	/** `/dashboard/postbox/<this>/<id>`: the folder id for a custom folder, else its role. */
	folderPath: string;
	activeMessageId: string;
	/** The list's visual order, for previous/next. */
	orderedIds: readonly string[];
	zen: boolean;
}>();
const emit = defineEmits<{ back: [] }>();
const { t } = useI18n();

const index = computed(() => props.orderedIds.indexOf(props.activeMessageId));
const previousId = computed(() =>
	index.value > 0 ? (props.orderedIds[index.value - 1] ?? null) : null
);
const nextId = computed(() =>
	index.value >= 0 ? (props.orderedIds[index.value + 1] ?? null) : null
);

/**
 * "(j)" after a step's label: the key that steps here, as the person has it
 * mapped. Only plain keys count, since those are what the handler below takes.
 */
function keyHint(id: 'postbox.next' | 'postbox.previous'): string {
	const chord = shortcutBindings.value.byId
		.get(id)
		?.find((step) => !step.startsWith('Arrow') && !step.includes('+') && !step.includes(' '));
	return chord ? ` (${formatChord(chord, false).join('')})` : '';
}

function open(id: string | null) {
	if (id) void navigateTo(`/dashboard/postbox/${props.folderPath}/${id}`);
}

// j/k in Zen: the list that normally owns them is not on screen.
function onKeydown(event: KeyboardEvent) {
	if (!props.zen || event.defaultPrevented) return;
	if (event.metaKey || event.ctrlKey || event.altKey) return;
	// The arrows keep scrolling the conversation; only the letters step.
	if (event.key.startsWith('Arrow')) return;
	if (isEditableTarget(event.target) || isDialogOpen()) return;
	const id = resolveActiveChord(event.key, ['postbox']);
	if (id !== 'postbox.next' && id !== 'postbox.previous') return;
	event.preventDefault();
	open(id === 'postbox.next' ? nextId.value : previousId.value);
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

const stepClass =
	'flex size-9 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-surface hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
</script>

<template>
	<div
		class="sticky top-0 z-10 flex items-center border-b border-border-subtle bg-bg-base"
		:class="zen ? 'px-2' : 'lg:hidden'"
	>
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-1.5 px-3 py-3 text-sm text-text-secondary outline-none hover:text-text-primary focus-visible:ring-1 focus-visible:ring-brand/40"
			@click="emit('back')"
		>
			<Icon name="lucide:arrow-left" class="size-4 shrink-0" />
			<span class="truncate capitalize">{{ folderName }}</span>
		</button>
		<template v-if="zen">
			<button
				type="button"
				:class="stepClass"
				:disabled="!previousId"
				:title="t('components.postbox.readerBackBar.previous') + keyHint('postbox.previous')"
				:aria-label="t('components.postbox.readerBackBar.previous')"
				@click="open(previousId)"
			>
				<Icon name="lucide:chevron-up" class="size-4" />
			</button>
			<button
				type="button"
				:class="stepClass"
				:disabled="!nextId"
				:title="t('components.postbox.readerBackBar.next') + keyHint('postbox.next')"
				:aria-label="t('components.postbox.readerBackBar.next')"
				@click="open(nextId)"
			>
				<Icon name="lucide:chevron-down" class="size-4" />
			</button>
		</template>
	</div>
</template>
