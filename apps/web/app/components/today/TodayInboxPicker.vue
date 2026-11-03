<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { InboxIdentity } from '~/utils/inboxIdentity';
import { Slider1Icon, SquareCheckIcon, SquareIcon } from '@coolicons/vue';

/**
 * Which inboxes get a Workbench tab. Each row is a checkbox that toggles
 * without closing the menu, so several inboxes can be switched in one go.
 * Leaving an inbox out only changes this person's Workbench: the inbox keeps
 * its place in the sidebar and its questions in the Answer queue, and
 * teammates who read the same inbox keep its tab.
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
const allShown = computed(() => shownCount.value === props.inboxes.length);
const triggerLabel = computed(() =>
	allShown.value
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
			<!-- Just the icon while every inbox has its tab; the count only when
			     some are left out, since that is worth seeing. The tooltip names
			     the icon alone; next to the count it would only repeat it. -->
			<UiTooltip :text="triggerLabel" :disabled="!allShown">
				<UiButton
					variant="ghost"
					size="sm"
					:class="allShown ? 'w-8 px-0' : ''"
					:aria-label="`${t('components.today.inboxPicker.label')}: ${triggerLabel}`"
				>
					<Slider1Icon class="size-4" />
					<span v-if="!allShown" class="ml-1.5">{{ triggerLabel }}</span>
				</UiButton>
			</UiTooltip>
		</template>
		<div class="px-3 pb-1 pt-2 text-2xs font-medium text-text-tertiary">
			{{ t('components.today.inboxPicker.heading') }}
		</div>
		<UiTooltip v-for="inbox in inboxes" :key="inbox.mailboxId" :text="inbox.address">
			<button
				type="button"
				role="menuitemcheckbox"
				:aria-checked="!hiddenSet.has(inbox.mailboxId)"
				class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-primary transition-colors hover:bg-bg-surface focus-visible:bg-bg-surface focus-visible:outline-none"
				@click.stop="emit('toggle', inbox.mailboxId, hiddenSet.has(inbox.mailboxId))"
			>
				<component
					:is="hiddenSet.has(inbox.mailboxId) ? SquareIcon : SquareCheckIcon"
					class="size-4 shrink-0"
					:class="hiddenSet.has(inbox.mailboxId) ? 'text-text-tertiary' : 'text-text-primary'"
					aria-hidden="true"
				/>
				<InboxChip :name="inbox.name" :slot="inbox.slot" variant="plain" size="md" />
			</button>
		</UiTooltip>
		<UiDropdownDivider />
		<p class="px-3 pb-2 pt-1.5 text-2xs text-text-tertiary">
			{{ t('components.today.inboxPicker.note') }}
		</p>
	</UiDropdownMenu>
</template>
