<script setup lang="ts">
/**
 * The composer's envelope fields (From/To/Cc/Bcc/Subject), split out of
 * PostboxComposer so each file stays a readable size. Address lists and the
 * subject are v-model'd straight onto the compose draft state; From changes
 * are delegated up (the identity swap is a server round-trip).
 */
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	fromAddress: string;
	availableIdentities: string[];
}>();

const emit = defineEmits<{
	(e: 'from-change', address: string): void;
}>();

const toAddresses = defineModel<string[]>('toAddresses', { required: true });
const ccAddresses = defineModel<string[]>('ccAddresses', { required: true });
const bccAddresses = defineModel<string[]>('bccAddresses', { required: true });
const subject = defineModel<string>('subject', { required: true });

// Show the From dropdown only when the mailbox actually has aliases —
// otherwise the single-identity case is implicit and we'd just add noise.
const showFromDropdown = computed(() => props.availableIdentities.length > 1);

function onFromChange(event: Event) {
	const target = event.target as HTMLSelectElement;
	if (!target.value) return;
	emit('from-change', target.value);
}

const showCc = ref(ccAddresses.value.length > 0);
const showBcc = ref(bccAddresses.value.length > 0);
</script>

<template>
	<div class="flex flex-col gap-1 p-3 border-b border-border-subtle text-sm">
		<div v-if="showFromDropdown" class="flex items-baseline gap-2">
			<label class="text-text-tertiary w-12">From</label>
			<select
				:value="fromAddress || availableIdentities[0]"
				class="flex-1 bg-transparent outline-none font-medium border-0"
				@change="onFromChange"
			>
				<option
					v-for="addr in availableIdentities"
					:key="addr"
					:value="addr"
				>
					{{ addr }}
				</option>
			</select>
		</div>
		<div class="flex items-start gap-2">
			<PostboxRecipientField
				v-model="toAddresses"
				:mailbox-id="mailboxId"
				label="To"
			/>
			<div class="flex items-center gap-2 text-xs pt-0.5">
				<button
					v-if="!showCc"
					type="button"
					class="text-text-tertiary hover:text-text-primary"
					@click="showCc = true"
				>Cc</button>
				<button
					v-if="!showBcc"
					type="button"
					class="text-text-tertiary hover:text-text-primary"
					@click="showBcc = true"
				>Bcc</button>
			</div>
		</div>
		<PostboxRecipientField
			v-if="showCc"
			v-model="ccAddresses"
			:mailbox-id="mailboxId"
			label="Cc"
		/>
		<PostboxRecipientField
			v-if="showBcc"
			v-model="bccAddresses"
			:mailbox-id="mailboxId"
			label="Bcc"
		/>
		<div class="flex items-baseline gap-2">
			<label for="subject" class="text-text-tertiary w-12">Subject</label>
			<input id="subject"
				v-model="subject"
				type="text"
				class="flex-1 bg-transparent outline-none font-medium"
			/>
		</div>
	</div>
</template>
