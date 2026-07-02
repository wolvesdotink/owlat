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

const stack = usePostboxComposerStack();
const { showToast } = useToast();

const oneClickOp = useBackendOperation(api.mail.unsubscribe.performOneClick, {
	label: 'Unsubscribe',
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
	const t = props.unsubscribe;
	if (t.oneClick && t.httpUrl) {
		// Explicit confirm — the POST is a state-changing request to a third
		// party and must never fire on render or by accident.
		const host = targetHost.value ?? 'the sender';
		if (!window.confirm(`Unsubscribe from this mailing list?\n\nOwlat will send the standard one-click unsubscribe request to ${host}.`)) {
			return;
		}
		const result = await oneClickOp.run({ messageId: props.messageId as Id<'mailMessages'> });
		if (result?.ok) {
			unsubscribed.value = true;
			showToast('Unsubscribe request sent');
		} else {
			// Fail-soft: fall back to opening the page so the user can finish
			// manually. When the action *threw* (result === undefined),
			// useBackendOperation already toasted the error — don't double up.
			if (result) {
				showToast('Unsubscribe request failed — opening the unsubscribe page instead', 'error');
			}
			window.open(t.httpUrl, '_blank', 'noopener,noreferrer');
		}
		return;
	}
	if (t.mailtoUrl) {
		const mailto = parseUnsubscribeMailto(t.mailtoUrl);
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
	if (t.httpUrl) {
		window.open(t.httpUrl, '_blank', 'noopener,noreferrer');
	}
}
</script>

<template>
	<span
		v-if="unsubscribed"
		class="inline-flex items-center gap-1 text-xs text-text-tertiary"
	>
		<Icon name="lucide:check" class="w-3 h-3" />
		Unsubscribed
	</span>
	<button
		v-else
		type="button"
		class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs text-text-tertiary border border-border-subtle hover:text-text-primary hover:bg-bg-elevated disabled:opacity-50"
		:disabled="oneClickOp.isLoading.value"
		title="Unsubscribe from this mailing list"
		aria-label="Unsubscribe from this mailing list"
		@click="onClick"
	>
		<Icon
			:name="oneClickOp.isLoading.value ? 'lucide:loader-2' : 'lucide:bell-off'"
			class="w-3 h-3"
			:class="{ 'animate-spin': oneClickOp.isLoading.value }"
		/>
		Unsubscribe
	</button>
</template>
