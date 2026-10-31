<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type { ListUnsubscribeTarget } from '@owlat/shared/listUnsubscribe';

/**
 * Quiet "Unsubscribe" chip for list mail, shown only when the message carried
 * a usable List-Unsubscribe header (parsed at ingest into
 * `mailMessages.unsubscribe`).
 *
 * Click behavior (after a confirm), best method first:
 *   - RFC 8058 One-Click (https + List-Unsubscribe-Post): the backend performs
 *     the POST server-side (SSRF-guarded, bounded timeout) and the result
 *     lands as a toast; a failure opens the sender's page.
 *   - mailto: opens a prefilled compose, when it names at least one To
 *     recipient (cc/bcc are ignored); otherwise the https target is used.
 *   - plain https: opens the sender's unsubscribe page in a new tab.
 * For personal mail every method also suppresses the sender locally.
 */
const props = defineProps<{
	messageId: string;
	mailboxId: string;
	unsubscribe: ListUnsubscribeTarget;
	/** Who the confirm names when there is no one-click host. */
	senderName?: string;
}>();

const { t } = useI18n();

const actions = usePostboxSenderActions();

/** One-click already succeeded in this reader session — flip the chip to a quiet "done". */
const unsubscribed = ref(false);

const targetHost = computed(() => {
	if (!props.unsubscribe.httpUrl) return null;
	try {
		return new URL(props.unsubscribe.httpUrl).hostname;
	} catch {
		return null;
	}
});

/**
 * The one unsubscribe path (`usePostboxSenderActions`): for personal mail the
 * sender is suppressed locally (future mail archived, undoable) and the
 * request's result is recorded; a team inbox gets the request only. The
 * one-click confirm names the host the state-changing request goes to, and
 * nothing ever fires on render.
 */
async function onClick() {
	const target = props.unsubscribe;
	const isOneClick = Boolean(target.oneClick && target.httpUrl);
	const outcome = await actions.unsubscribe(
		{ messageId: props.messageId as Id<'mailMessages'> },
		{
			mailboxId: props.mailboxId,
			name: props.senderName,
			oneClickHost: isOneClick
				? (targetHost.value ?? t('components.postbox.postboxUnsubscribeChip.theSender'))
				: null,
		}
	);
	if (outcome?.result === 'confirmed') unsubscribed.value = true;
}
</script>

<template>
	<span v-if="unsubscribed" class="inline-flex items-center gap-1 text-xs text-text-tertiary">
		<Icon name="lucide:check" class="w-3 h-3" />
		{{ t('components.postbox.postboxUnsubscribeChip.unsubscribed') }}
	</span>
	<UiTooltip v-else :text="t('components.postbox.postboxUnsubscribeChip.chipTitle')">
		<button
			type="button"
			class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-text-tertiary border border-border-subtle hover:text-text-primary hover:bg-bg-elevated disabled:opacity-50"
			:disabled="actions.isBusy.value"
			:aria-label="t('components.postbox.postboxUnsubscribeChip.chipTitle')"
			@click="onClick"
		>
			<Icon
				:name="actions.isBusy.value ? 'lucide:loader-2' : 'lucide:bell-off'"
				class="w-3 h-3"
				:class="{ 'animate-spin motion-reduce:animate-none': actions.isBusy.value }"
			/>
			{{ t('components.postbox.postboxUnsubscribeChip.unsubscribe') }}
		</button>
	</UiTooltip>
</template>
