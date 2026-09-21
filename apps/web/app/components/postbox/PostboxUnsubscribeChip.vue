<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { escapeHtmlWithBreaks } from '@owlat/shared/html';

/**
 * Quiet "Unsubscribe" chip for list mail, shown only when the message carried
 * a usable List-Unsubscribe header (parsed at ingest into
 * `mailMessages.unsubscribe`).
 *
 * Click behavior, best method first:
 *   - RFC 8058 One-Click (https + List-Unsubscribe-Post): confirm, then the
 *     backend performs the POST server-side (SSRF-guarded, bounded timeout)
 *     and the result lands as a toast. Never fired on render.
 *   - mailto: opens a prefilled compose.
 *   - plain https: opens the sender's unsubscribe page in a new tab.
 */
const props = defineProps<{
	messageId: string;
	mailboxId: string;
	unsubscribe: { httpUrl?: string; mailtoUrl?: string; oneClick: boolean };
}>();

const { t } = useI18n();

const stack = usePostboxComposerStack();
const { showToast } = useToast();

const oneClickOp = useBackendOperation(api.mail.unsubscribe.performOneClick, {
	label: () => t('components.postbox.postboxUnsubscribeChip.unsubscribe'),
	type: 'action',
});

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

async function onClick() {
	// NOT named `t` — that is the i18n translator this function calls.
	const target = props.unsubscribe;
	if (target.oneClick && target.httpUrl) {
		// Explicit confirm — the POST is a state-changing request to a third
		// party and must never fire on render or by accident.
		const host = targetHost.value ?? t('components.postbox.postboxUnsubscribeChip.theSender');
		if (!window.confirm(t('components.postbox.postboxUnsubscribeChip.confirm', { host }))) {
			return;
		}
		const result = await oneClickOp.run({ messageId: props.messageId as Id<'mailMessages'> });
		if (result.ok && result.result.ok) {
			unsubscribed.value = true;
			showToast(t('components.postbox.postboxUnsubscribeChip.requestSent'));
		} else {
			// Fail-soft: fall back to opening the page so the user can finish
			// manually. When the action *threw* (!result.ok),
			// useBackendOperation already toasted the error — don't double up.
			if (result.ok) {
				showToast(t('components.postbox.postboxUnsubscribeChip.requestFailed'), 'error');
			}
			window.open(target.httpUrl, '_blank', 'noopener,noreferrer');
		}
		return;
	}
	if (target.mailtoUrl) {
		const mailto = parseUnsubscribeMailto(target.mailtoUrl);
		if (mailto) {
			stack.open({
				mailboxId: props.mailboxId as Id<'mailboxes'>,
				prefillTo: mailto.to,
				prefillSubject: mailto.subject ?? 'Unsubscribe',
				// The header is attacker-controlled — mailto bodies are plain
				// text, so escape before embedding as compose HTML.
				...(mailto.body ? { prefillBodyHtml: `<p>${escapeHtmlWithBreaks(mailto.body)}</p>` } : {}),
			});
			return;
		}
	}
	if (target.httpUrl) {
		window.open(target.httpUrl, '_blank', 'noopener,noreferrer');
	}
}
</script>

<template>
	<span v-if="unsubscribed" class="inline-flex items-center gap-1 text-xs text-text-tertiary">
		<Icon name="lucide:check" class="w-3 h-3" />
		{{ t('components.postbox.postboxUnsubscribeChip.unsubscribed') }}
	</span>
	<button
		v-else
		type="button"
		class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-text-tertiary border border-border-subtle hover:text-text-primary hover:bg-bg-elevated disabled:opacity-50"
		:disabled="oneClickOp.isLoading.value"
		:title="t('components.postbox.postboxUnsubscribeChip.chipTitle')"
		:aria-label="t('components.postbox.postboxUnsubscribeChip.chipTitle')"
		@click="onClick"
	>
		<Icon
			:name="oneClickOp.isLoading.value ? 'lucide:loader-2' : 'lucide:bell-off'"
			class="w-3 h-3"
			:class="{ 'animate-spin motion-reduce:animate-none': oneClickOp.isLoading.value }"
		/>
		{{ t('components.postbox.postboxUnsubscribeChip.unsubscribe') }}
	</button>
</template>
