<script setup lang="ts">
/**
 * The composer's envelope fields (From/To/Cc/Bcc/Subject), split out of
 * PostboxComposer so each file stays a readable size. Address lists and the
 * subject are v-model'd straight onto the compose draft state; From changes
 * are delegated up (the identity swap is a server round-trip).
 */
import type { Id } from '@owlat/api/dataModel';
import {
	ownDomainsFromIdentities,
	recipientLabel,
	canonicalEmailAddress,
} from '~/utils/recipientHints';

type RecipientField = 'to' | 'cc' | 'bcc';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	fromAddress: string;
	availableIdentities: string[];
	/** Extra recipients Reply-All would add (raw addresses); drives the gap hint. */
	replyAllRecipients?: string[];
}>();

const emit = defineEmits<{
	(e: 'from-change', address: string): void;
	(e: 'apply-reply-all'): void;
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

// The user's own domains (from the sending identities) — used purely client-side
// to flag a recipient chip that's outside the org.
const ownDomains = computed(() =>
	ownDomainsFromIdentities([
		...(props.fromAddress ? [props.fromAddress] : []),
		...props.availableIdentities,
	])
);

// ─── Reply-all gap hint ──────────────────────────────────────────────────────
// Shown once, dismissibly, when a plain Reply left out other recipients.
const replyAllHintDismissed = ref(false);
const showReplyAllHint = computed(
	() => !replyAllHintDismissed.value && (props.replyAllRecipients?.length ?? 0) > 0
);
const replyAllHintNames = computed(() =>
	(props.replyAllRecipients ?? []).map(recipientLabel).join(', ')
);
function applyReplyAll() {
	// Reveal Cc so the newly-added recipients are visible.
	showCc.value = true;
	replyAllHintDismissed.value = true;
	emit('apply-reply-all');
}

// ─── Drag a chip between To / Cc / Bcc ───────────────────────────────────────
const fieldModels: Record<RecipientField, { value: string[] }> = {
	to: toAddresses,
	cc: ccAddresses,
	bcc: bccAddresses,
};

function moveRecipient(payload: { email: string; from: RecipientField }, to: RecipientField) {
	if (payload.from === to) return;
	const source = fieldModels[payload.from];
	const target = fieldModels[to];
	const canon = canonicalEmailAddress(payload.email);
	source.value = source.value.filter((a) => canonicalEmailAddress(a) !== canon);
	if (!target.value.some((a) => canonicalEmailAddress(a) === canon)) {
		target.value = [...target.value, payload.email];
	}
	if (to === 'cc') showCc.value = true;
	if (to === 'bcc') showBcc.value = true;
}
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
				field="to"
				:own-domains="ownDomains"
				@move="moveRecipient($event, 'to')"
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
		<div
			v-if="showReplyAllHint"
			class="flex items-center gap-2 pl-14 text-xs text-text-tertiary"
			data-testid="postbox-reply-all-hint"
		>
			<span>Also include {{ replyAllHintNames }}?</span>
			<button
				type="button"
				class="text-brand hover:underline"
				@click="applyReplyAll"
			>reply-all</button>
			<button
				type="button"
				class="text-text-tertiary hover:text-text-primary"
				aria-label="Dismiss"
				@click="replyAllHintDismissed = true"
			>
				<Icon name="lucide:x" class="w-3 h-3" />
			</button>
		</div>
		<PostboxRecipientField
			v-if="showCc"
			v-model="ccAddresses"
			:mailbox-id="mailboxId"
			label="Cc"
			field="cc"
			:own-domains="ownDomains"
			@move="moveRecipient($event, 'cc')"
		/>
		<PostboxRecipientField
			v-if="showBcc"
			v-model="bccAddresses"
			:mailbox-id="mailboxId"
			label="Bcc"
			field="bcc"
			:own-domains="ownDomains"
			@move="moveRecipient($event, 'bcc')"
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
