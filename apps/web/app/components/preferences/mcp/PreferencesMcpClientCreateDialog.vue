<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import type { McpClientAccess } from '~/composables/useMcpClients';

const props = defineProps<{ busy: boolean }>();

const emit = defineEmits<{
	(e: 'cancel'): void;
	(
		e: 'submit',
		value: { label: string; mailboxIds: Id<'mailboxes'>[]; access: McpClientAccess }
	): void;
}>();

const { t } = useI18n();

// The same list as the mailbox switcher: a client can only be pointed at
// mailboxes the member already reads in Postbox.
const {
	data: mailboxData,
	isLoading,
	error: mailboxError,
	refetch: refetchMailboxes,
} = useConvexQuery(api.mail.mailbox.queries.accessible, () => ({}));
const mailboxes = computed(() => mailboxData.value ?? []);

const label = ref('');
const selected = ref<Id<'mailboxes'>[]>([]);
// Read-only unless the member chooses otherwise: a write still waits for them.
const access = ref<McpClientAccess>('read');

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

function onOpenChange(open: boolean) {
	if (!open) emit('cancel');
}

function submit() {
	if (!canSubmit.value) return;
	emit('submit', {
		label: label.value.trim(),
		mailboxIds: [...selected.value],
		access: access.value,
	});
}
</script>

<template>
	<!-- Mounted by the page only while open, so the dialog is always open here. -->
	<UiModal
		:open="true"
		:title="t('components.preferences.mcpClientCreateDialog.title')"
		size="md"
		:persistent="busy"
		initial-focus="#mcp-client-label"
		@update:open="onOpenChange"
	>
		<form id="mcp-client-create-form" class="space-y-5" @submit.prevent="submit">
			<div>
				<label for="mcp-client-label" class="label">{{
					t('components.preferences.mcpClientCreateDialog.nameLabel')
				}}</label>
				<input
					id="mcp-client-label"
					v-model="label"
					type="text"
					maxlength="80"
					:placeholder="t('components.preferences.mcpClientCreateDialog.namePlaceholder')"
					class="input w-full"
				/>
			</div>
			<fieldset>
				<legend class="label">
					{{ t('components.preferences.mcpClientCreateDialog.mailboxesLegend') }}
				</legend>
				<p v-if="isLoading" class="text-sm text-text-tertiary">{{ t('common.loading') }}</p>
				<UiQueryBoundary v-else-if="mailboxError" :error="mailboxError" @retry="refetchMailboxes" />
				<p v-else-if="mailboxes.length === 0" class="text-sm text-text-secondary">
					{{ t('components.preferences.mcpClientCreateDialog.noMailboxes') }}
				</p>
				<div v-else class="space-y-2">
					<UiSelectableListItem
						v-for="mailbox in mailboxes"
						:key="mailbox.mailboxId"
						:model-value="selected"
						type="checkbox"
						:value="mailbox.mailboxId"
						:label="mailbox.label"
						:description="mailbox.label !== mailbox.address ? mailbox.address : undefined"
						@update:model-value="(value) => (selected = value as Id<'mailboxes'>[])"
					/>
				</div>
			</fieldset>
			<fieldset>
				<legend class="label">
					{{ t('components.preferences.mcpClientCreateDialog.accessLegend') }}
				</legend>
				<div class="space-y-2">
					<UiSelectableListItem
						:model-value="access"
						type="radio"
						name="mcp-client-access"
						value="read"
						@update:model-value="(value) => (access = value as McpClientAccess)"
						:label="t('components.preferences.mcpClientCreateDialog.readOption')"
						:description="t('components.preferences.mcpClientCreateDialog.readHint')"
					/>
					<UiSelectableListItem
						:model-value="access"
						type="radio"
						name="mcp-client-access"
						value="read_write"
						@update:model-value="(value) => (access = value as McpClientAccess)"
						:label="t('components.preferences.mcpClientCreateDialog.readWriteOption')"
						:description="t('components.preferences.mcpClientCreateDialog.readWriteHint')"
					/>
				</div>
			</fieldset>
		</form>
		<template #footer>
			<UiButton variant="ghost" type="button" :disabled="busy" @click="emit('cancel')">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton type="submit" form="mcp-client-create-form" :disabled="!canSubmit" :loading="busy">
				{{ t('components.preferences.mcpClientCreateDialog.submit') }}
			</UiButton>
		</template>
	</UiModal>
</template>
