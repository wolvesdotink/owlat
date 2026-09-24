<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { InboxIdentity } from '~/utils/inboxIdentity';

/**
 * Which inboxes feed Today. Each row is a checkbox that toggles without
 * closing the menu, so several inboxes can be switched in one go. Leaving an
 * inbox out only changes this person's Today: the inbox keeps its place in the
 * sidebar and its questions in the Answer queue, and teammates who read the
 * same inbox keep it on their own Today.
 */
const props = defineProps<{
	inboxes: readonly InboxIdentity<Id<'mailboxes'>>[];
	hidden: readonly Id<'mailboxes'>[];
}>();
const emit = defineEmits<{ toggle: [mailboxId: Id<'mailboxes'>, shown: boolean] }>();

const { t } = useI18n();
const open = ref(false);

const hiddenSet = computed(() => new Set<string>(props.hidden));
const shownCount = computed(
	() => props.inboxes.filter((inbox) => !hiddenSet.value.has(inbox.mailboxId)).length
);
const triggerLabel = computed(() =>
	shownCount.value === props.inboxes.length
		? t('components.today.inboxPicker.all')
		: t('components.today.inboxPicker.some', {
				shown: shownCount.value,
				total: props.inboxes.length,
			})
);
</script>

<template>
	<UiDropdownMenu v-model:open="open" position="right">
		<template #trigger>
			<UiButton
				variant="secondary"
				size="sm"
				:aria-label="`${t('components.today.inboxPicker.label')}: ${triggerLabel}`"
			>
				<template #iconLeft><Icon name="lucide:inbox" class="size-4" /></template>
				{{ triggerLabel }}
			</UiButton>
		</template>
		<div class="px-3 pb-1 pt-2 text-2xs font-medium text-text-tertiary">
			{{ t('components.today.inboxPicker.heading') }}
		</div>
		<button
			v-for="inbox in inboxes"
			:key="inbox.mailboxId"
			type="button"
			role="menuitemcheckbox"
			:aria-checked="!hiddenSet.has(inbox.mailboxId)"
			:title="inbox.address"
			class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-primary transition-colors hover:bg-bg-surface focus-visible:bg-bg-surface focus-visible:outline-none"
			@click.stop="emit('toggle', inbox.mailboxId, hiddenSet.has(inbox.mailboxId))"
		>
			<Icon
				:name="hiddenSet.has(inbox.mailboxId) ? 'lucide:square' : 'lucide:square-check'"
				class="size-4 shrink-0"
				:class="hiddenSet.has(inbox.mailboxId) ? 'text-text-tertiary' : 'text-text-primary'"
				aria-hidden="true"
			/>
			<InboxChip :name="inbox.name" :slot="inbox.slot" variant="plain" size="md" />
		</button>
		<UiDropdownDivider />
		<p class="px-3 pb-2 pt-1.5 text-2xs text-text-tertiary">
			{{ t('components.today.inboxPicker.note') }}
		</p>
	</UiDropdownMenu>
</template>
