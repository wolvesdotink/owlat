<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{ busy: boolean }>();

const emit = defineEmits<{
	(e: 'cancel'): void;
	(e: 'submit', value: { label: string; mailboxIds: Id<'mailboxes'>[] }): void;
}>();

const { t } = useI18n();

// The same list as the mailbox switcher: a client can only be pointed at
// mailboxes the member already reads in Postbox.
const { data: mailboxData, isLoading } = useConvexQuery(
	api.mail.mailbox.queries.accessible,
	() => ({})
);
const mailboxes = computed(() => mailboxData.value ?? []);

const label = ref('');
const selected = ref<Id<'mailboxes'>[]>([]);

watch(
	mailboxes,
	(rows) => {
		// One mailbox: nothing to choose, so it is chosen.
		if (rows.length === 1 && selected.value.length === 0) selected.value = [rows[0]!.mailboxId];
	},
	{ immediate: true }
);

const canSubmit = computed(
	() => label.value.trim().length > 0 && selected.value.length > 0 && !props.busy
);

function submit() {
	if (!canSubmit.value) return;
	emit('submit', { label: label.value.trim(), mailboxIds: [...selected.value] });
}
</script>

<template>
	<div
		class="fixed inset-0 bg-scrim/50 flex items-center justify-center z-40"
		@click.self="emit('cancel')"
	>
		<form class="bg-bg-elevated rounded-md w-full max-w-md p-5 shadow-2xl" @submit.prevent="submit">
			<h2 class="text-lg font-semibold mb-3">
				{{ t('components.preferences.mcpClientCreateDialog.title') }}
			</h2>
			<label for="mcp-client-label" class="text-sm font-medium block mb-1">{{
				t('components.preferences.mcpClientCreateDialog.nameLabel')
			}}</label>
			<input
				id="mcp-client-label"
				v-model="label"
				type="text"
				maxlength="80"
				:placeholder="t('components.preferences.mcpClientCreateDialog.namePlaceholder')"
				class="input w-full"
				autofocus
			/>
			<fieldset class="mt-4">
				<legend class="text-sm font-medium mb-1">
					{{ t('components.preferences.mcpClientCreateDialog.mailboxesLegend') }}
				</legend>
				<p v-if="isLoading" class="text-sm text-text-tertiary">{{ t('common.loading') }}</p>
				<p v-else-if="mailboxes.length === 0" class="text-sm text-text-secondary">
					{{ t('components.preferences.mcpClientCreateDialog.noMailboxes') }}
				</p>
				<label
					v-for="mailbox in mailboxes"
					v-else
					:key="mailbox.mailboxId"
					class="flex items-center gap-2 text-sm mt-1"
				>
					<input v-model="selected" type="checkbox" :value="mailbox.mailboxId" />
					<span class="min-w-0 break-words">{{ mailbox.label }}</span>
					<span v-if="mailbox.label !== mailbox.address" class="text-text-tertiary break-all">{{
						mailbox.address
					}}</span>
				</label>
			</fieldset>
			<p class="text-xs text-text-tertiary mt-4">
				{{ t('components.preferences.mcpClientCreateDialog.readOnlyHint') }}
			</p>
			<div class="flex items-center justify-end gap-2 mt-5">
				<UiButton variant="ghost" type="button" @click="emit('cancel')">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton type="submit" :disabled="!canSubmit">
					{{ t('components.preferences.mcpClientCreateDialog.submit') }}
				</UiButton>
			</div>
		</form>
	</div>
</template>
