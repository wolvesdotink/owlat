<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { extractEmailAddress } from '~/utils/emailAddress';

/**
 * Per-sender triage corrections in the thread reader header: an explicit VIP
 * ("important sender") star and a HEY-style "Accept sender" button for a
 * first-time sender the screener is holding out of the Reply Queue.
 *
 * These are the transparent, easy-to-correct overrides of the deterministic
 * frecency baseline — a VIP dominates the priority score, and accepting a
 * screened sender lets their mail into the queue from now on. Fail-soft: the
 * query returns a safe empty state for anonymous / non-owner reads, so nothing
 * renders and the reader is never blocked.
 */
const props = defineProps<{
	mailboxId: string;
	fromAddress: string;
}>();

const { t } = useI18n();

const email = computed(() => extractEmailAddress(props.fromAddress));

const { data } = useConvexQuery(api.mail.contacts.senderState, () => ({
	mailboxId: props.mailboxId as Id<'mailboxes'>,
	email: email.value,
}));

const isVip = computed(() => data.value?.isVip === true);
// Show "Accept sender" only when the screener is on AND this sender is neither
// a known contact nor already waved through — i.e. exactly the first-timers
// the screener is currently holding out of the queue.
const canAccept = computed(
	() =>
		data.value?.isScreenerEnabled === true &&
		data.value?.isKnown !== true &&
		data.value?.isScreenerAccepted !== true
);

const setVipOp = useBackendOperation(api.mail.contacts.setVip, {
	label: () => t('components.postbox.postboxSenderControls.vipOperation'),
});
const acceptOp = useBackendOperation(api.mail.contacts.acceptSender, {
	label: () => t('components.postbox.postboxSenderControls.acceptOperation'),
});

function toggleVip() {
	void setVipOp.run({
		mailboxId: props.mailboxId as Id<'mailboxes'>,
		email: email.value,
		isVip: !isVip.value,
	});
}

function acceptSender() {
	void acceptOp.run({
		mailboxId: props.mailboxId as Id<'mailboxes'>,
		email: email.value,
	});
}
</script>

<template>
	<div class="flex items-center gap-1.5 flex-shrink-0">
		<button
			v-if="canAccept"
			type="button"
			class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-50"
			:title="t('components.postbox.postboxSenderControls.acceptTitle')"
			:aria-label="t('components.postbox.postboxSenderControls.accept')"
			:disabled="acceptOp.isLoading.value"
			@click.stop.prevent="acceptSender"
		>
			<Icon name="lucide:user-check" class="w-3.5 h-3.5" />
			{{ t('components.postbox.postboxSenderControls.accept') }}
		</button>
		<button
			type="button"
			class="text-text-tertiary hover:text-warning disabled:opacity-50"
			:class="{ 'text-warning': isVip }"
			:title="
				isVip
					? t('components.postbox.postboxSenderControls.removeVip')
					: t('components.postbox.postboxSenderControls.markVip')
			"
			:aria-label="
				isVip
					? t('components.postbox.postboxSenderControls.removeVip')
					: t('components.postbox.postboxSenderControls.markVip')
			"
			:aria-pressed="isVip"
			:disabled="setVipOp.isLoading.value"
			@click.stop.prevent="toggleVip"
		>
			<Icon
				name="lucide:crown"
				class="w-3.5 h-3.5"
				:class="{ 'fill-current': isVip }"
			/>
		</button>
	</div>
</template>
