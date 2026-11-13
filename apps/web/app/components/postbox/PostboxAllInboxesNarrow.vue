<script setup lang="ts">
/**
 * The list-header control of All inboxes and the unified folders: narrow the
 * merged list to one mailbox or to the mailboxes of one provider without
 * leaving the view, and clear the narrow again. The provider group only shows
 * when the mailboxes span more than one provider.
 */
import type { InboxIdentity } from '~/utils/inboxIdentity';
import { OWLAT_PROVIDER, providerName } from '~/utils/postboxAllInboxes';
import InboxChip from '~/components/inbox/InboxChip.vue';
import { ChevronDownIcon, CloseIcon, FilterIcon } from '@coolicons/vue';

const props = defineProps<{
	inboxes: readonly InboxIdentity[];
	providers: readonly { key: string; count: number }[];
	only: string | null;
	provider: string | null;
}>();

const emit = defineEmits<{
	narrow: [filter: { in: string | null; provider: string | null }];
}>();

const { t } = useI18n();
const open = ref(false);

function labelFor(key: string): string {
	return providerName(key) ?? t('components.postbox.allInboxes.narrow.owlat');
}

const current = computed(() => {
	if (props.only) {
		const inbox = props.inboxes.find((i) => i.mailboxId === props.only);
		if (inbox) return inbox.name;
	}
	if (props.provider) return labelFor(props.provider);
	return t('components.postbox.allInboxes.narrow.all');
});
const isNarrowed = computed(() => props.only !== null || props.provider !== null);
const showProviders = computed(() => props.providers.length > 1);
// The pill truncates the current choice, so its name and tooltip carry it whole.
const triggerLabel = computed(() =>
	t('components.postbox.allInboxes.narrow.triggerLabel', { current: current.value })
);
</script>

<template>
	<div v-if="inboxes.length > 1" class="flex items-center gap-1 min-w-0">
		<UiDropdownMenu v-model:open="open" position="left" class="min-w-0">
			<template #trigger>
				<UiTooltip :text="triggerLabel">
					<button
						type="button"
						class="inline-flex items-center gap-1 max-w-48 rounded-full px-2.5 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						:class="
							isNarrowed
								? 'bg-bg-elevated text-text-primary shadow-(--shadow-1)'
								: 'text-text-secondary hover:bg-bg-elevated hover:text-text-primary'
						"
						:aria-label="triggerLabel"
						data-testid="all-inboxes-narrow"
					>
						<FilterIcon class="size-3.5 flex-shrink-0" />
						<span class="truncate">{{ current }}</span>
						<ChevronDownIcon class="size-3 flex-shrink-0" />
					</button>
				</UiTooltip>
			</template>

			<UiDropdownMenuItem @click="emit('narrow', { in: null, provider: null })">
				<span class="flex-1 truncate text-left" :class="{ 'text-brand': !isNarrowed }">{{
					t('components.postbox.allInboxes.narrow.all')
				}}</span>
			</UiDropdownMenuItem>
			<p class="px-3 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-text-tertiary">
				{{ t('components.postbox.allInboxes.narrow.mailboxesHeading') }}
			</p>
			<UiDropdownMenuItem
				v-for="inbox in inboxes"
				:key="inbox.mailboxId"
				@click="emit('narrow', { in: inbox.mailboxId, provider: null })"
			>
				<InboxChip
					:name="inbox.name"
					:slot="inbox.slot"
					:mark="inbox.mark"
					variant="plain"
					size="md"
					:class="{ 'text-brand': only === inbox.mailboxId }"
				/>
			</UiDropdownMenuItem>
			<template v-if="showProviders">
				<p
					class="px-3 pt-2 pb-1 text-2xs font-semibold uppercase tracking-wider text-text-tertiary"
				>
					{{ t('components.postbox.allInboxes.narrow.providersHeading') }}
				</p>
				<UiDropdownMenuItem
					v-for="entry in providers"
					:key="entry.key"
					@click="emit('narrow', { in: null, provider: entry.key })"
				>
					<span
						class="flex-1 truncate text-left"
						:class="{ 'text-brand': !only && provider === entry.key }"
						:title="entry.key === OWLAT_PROVIDER ? undefined : entry.key"
						>{{ labelFor(entry.key) }}</span
					>
					<span class="text-xs tabular-nums text-text-tertiary">{{ entry.count }}</span>
				</UiDropdownMenuItem>
			</template>
		</UiDropdownMenu>
		<UiTooltip v-if="isNarrowed" :text="t('components.postbox.allInboxes.narrow.clear')">
			<button
				type="button"
				class="p-1 rounded-full text-text-tertiary hover:text-text-primary hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
				:aria-label="t('components.postbox.allInboxes.narrow.clear')"
				data-testid="all-inboxes-narrow-clear"
				@click="emit('narrow', { in: null, provider: null })"
			>
				<CloseIcon class="size-3" />
			</button>
		</UiTooltip>
	</div>
</template>
