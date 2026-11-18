<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

/**
 * Which mailbox a mail settings page edits, at the top of the page. Settings
 * hides the Postbox sidebar and its switcher, so without this nothing on screen
 * says whose auto-reply or filters are open. With more than one mailbox to
 * choose from it is a select; with one it is plain text.
 *
 * `locked` holds the select while the page has edits that belong to the
 * current mailbox: a switch would reload the form and drop them.
 */
const props = defineProps<{
	mailboxes: ReadonlyArray<{ _id: Id<'mailboxes'>; address: string; displayName?: string }>;
	mailboxId: Id<'mailboxes'>;
	locked?: boolean;
}>();

const emit = defineEmits<{ select: [id: Id<'mailboxes'>] }>();

const { t } = useI18n();

const current = computed(() => props.mailboxes.find((m) => m._id === props.mailboxId) ?? null);

function nameOf(mailbox: { address: string; displayName?: string }): string | null {
	const name = mailbox.displayName?.trim();
	return name && name !== mailbox.address ? name : null;
}

function optionLabel(mailbox: { address: string; displayName?: string }): string {
	const name = nameOf(mailbox);
	return name ? `${name} (${mailbox.address})` : mailbox.address;
}

function onChange(event: Event) {
	const id = (event.target as HTMLSelectElement).value as Id<'mailboxes'>;
	if (id !== props.mailboxId) emit('select', id);
}
</script>

<template>
	<div v-if="current" class="mb-5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
		<template v-if="mailboxes.length > 1">
			<label for="settings-mailbox" class="text-sm text-text-secondary">
				{{ t('components.preferences.preferencesMailboxPicker.label') }}
			</label>
			<select
				id="settings-mailbox"
				class="input w-full sm:w-auto sm:max-w-md min-w-0"
				:value="mailboxId"
				:disabled="locked"
				:aria-describedby="locked ? 'settings-mailbox-locked' : undefined"
				@change="onChange"
			>
				<option v-for="mailbox in mailboxes" :key="mailbox._id" :value="mailbox._id">
					{{ optionLabel(mailbox) }}
				</option>
			</select>
			<p v-if="locked" id="settings-mailbox-locked" class="w-full text-xs text-text-tertiary">
				{{ t('components.preferences.preferencesMailboxPicker.locked') }}
			</p>
		</template>
		<p v-else class="text-sm min-w-0 break-words" data-testid="settings-mailbox">
			<span class="text-text-secondary">
				{{ t('components.preferences.preferencesMailboxPicker.label') }}
			</span>
			<span v-if="nameOf(current)" class="ml-2 font-medium">{{ nameOf(current) }}</span>
			<span class="ml-2 font-mono text-text-secondary">{{ current.address }}</span>
		</p>
	</div>
</template>
