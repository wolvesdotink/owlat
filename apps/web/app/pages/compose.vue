<script setup lang="ts">
import { escapeHtmlWithBreaks } from '@owlat/shared/html';
import type { ComposerSeed } from '~/composables/postbox/usePostboxCompose';

/**
 * Dedicated compose route for the desktop compose window. Seeded from the route
 * query (mailto: → ?to=…&subject=…). Closes the window after discard.
 *
 * After a send the composer is put away and the window stays open with the
 * undo toast (the composer armed it, and played the send sound) until the undo
 * window runs out; then it closes. Undo brings the recovered draft back into
 * this same window.
 */
const { t } = useI18n();

useHead({ title: () => t('compose.pageTitle') });
definePageMeta({
	layout: 'compose',
	middleware: 'auth',
});

const route = useRoute();
const { currentMailbox, isLoading } = usePostboxMailbox();
const stack = usePostboxComposerStack();

function splitAddresses(raw: string): string[] {
	return raw
		? raw
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
}

const querySeed = computed<ComposerSeed | null>(() => {
	const mailbox = currentMailbox.value;
	if (!mailbox) return null;
	const body = String(route.query['body'] ?? '');
	return {
		mailboxId: mailbox._id,
		prefillTo: splitAddresses(String(route.query['to'] ?? '')),
		prefillCc: splitAddresses(String(route.query['cc'] ?? '')),
		prefillBcc: splitAddresses(String(route.query['bcc'] ?? '')),
		prefillSubject: String(route.query['subject'] ?? ''),
		// mailto bodies are plain text — escape and preserve line breaks.
		prefillBodyHtml: body ? escapeHtmlWithBreaks(body) : '',
	};
});

// The draft an undo handed back; it replaces the mailto seed from then on.
const reopenedSeed = ref<ComposerSeed | null>(null);
const seed = computed(() => reopenedSeed.value ?? querySeed.value);
// The composer reads its seed once, so a reopened draft remounts it.
const composerKey = ref(0);
const sent = ref(false);

async function closeWindow() {
	try {
		const { closeComposeWindow } = await import('@owlat/desktop/src/compose');
		await closeComposeWindow();
	} catch {
		// Not in the desktop window — no-op.
	}
}

function onSent({ scheduled }: { scheduled: boolean }) {
	// A scheduled send waits in Scheduled; there is no undo window to sit out.
	if (scheduled) {
		void closeWindow();
		return;
	}
	sent.value = true;
}

function onExpired() {
	if (sent.value) void closeWindow();
}

/**
 * Undo reopens the recovered draft on the composer stack (PostboxUndoSendToast
 * does that for every host). This window renders no stack, so it takes that
 * composer over as its own. Nothing on the stack means the undo came too late
 * and the message went out: close as if the window had expired.
 */
function onUndone() {
	const stacked = stack.state.value;
	const reopened = stacked[stacked.length - 1];
	if (!reopened) {
		void closeWindow();
		return;
	}
	stack.close(reopened.id);
	reopenedSeed.value = reopened;
	composerKey.value += 1;
	sent.value = false;
}
</script>

<template>
	<div class="ui-window-enter mx-auto flex h-dvh max-w-3xl flex-col p-4">
		<template v-if="seed">
			<p v-if="sent" class="m-auto text-sm text-text-secondary">
				{{ t('compose.sentNotice') }}
			</p>
			<PostboxComposer
				v-else
				:key="composerKey"
				class="min-h-0 flex-1"
				:seed="seed"
				@sent="onSent"
				@discarded="closeWindow"
			/>
		</template>
		<p v-else-if="isLoading" class="text-sm text-text-secondary">
			{{ t('compose.loadingMailbox') }}
		</p>
		<p v-else class="text-sm text-text-secondary">{{ t('compose.noMailbox') }}</p>
		<PostboxUndoSendToast @expired="onExpired" @undone="onUndone" />
	</div>
</template>
