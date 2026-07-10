<script setup lang="ts">
import { escapeHtmlWithBreaks } from '@owlat/shared/html';

/**
 * Dedicated compose route for the desktop compose window. Seeded from the route
 * query (mailto: → ?to=…&subject=…). Closes the window after send/discard.
 */
useHead({ title: 'Compose — Owlat' });
definePageMeta({
	layout: 'compose',
	middleware: 'auth',
});

const route = useRoute();
const { currentMailbox, isLoading } = usePostboxMailbox();

function splitAddresses(raw: string): string[] {
	return raw
		? raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
}

const prefillTo = computed(() => splitAddresses(String(route.query['to'] ?? '')));
const prefillCc = computed(() => splitAddresses(String(route.query['cc'] ?? '')));
const prefillBcc = computed(() => splitAddresses(String(route.query['bcc'] ?? '')));
const prefillSubject = computed(() => String(route.query['subject'] ?? ''));
const prefillBodyHtml = computed(() => {
	const body = String(route.query['body'] ?? '');
	// mailto bodies are plain text — escape and preserve line breaks.
	return body ? escapeHtmlWithBreaks(body) : '';
});

async function closeWindow() {
	try {
		const { closeComposeWindow } = await import('@owlat/desktop/src/compose');
		await closeComposeWindow();
	} catch {
		// Not in the desktop window — no-op.
	}
}
</script>

<template>
	<div class="ui-window-enter mx-auto max-w-3xl p-4">
		<PostboxComposer
			v-if="currentMailbox"
			:mailbox-id="currentMailbox._id"
			:prefill-to="prefillTo"
			:prefill-cc="prefillCc"
			:prefill-bcc="prefillBcc"
			:prefill-subject="prefillSubject"
			:prefill-body-html="prefillBodyHtml"
			@sent="closeWindow"
			@discarded="closeWindow"
		/>
		<p v-else-if="isLoading" class="text-sm text-text-secondary">Loading mailbox…</p>
		<p v-else class="text-sm text-text-secondary">No mailbox is configured for this workspace.</p>
	</div>
</template>
