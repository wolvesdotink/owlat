<script setup lang="ts">
/**
 * Reply interstitial for messages that FAILED sender authentication (Sealed
 * Mail A3, flag `senderAuthBadges`). Replying to a spoofed sender mails the
 * impersonator, so before a reply / reply-all to a "failed" message we ask the
 * reader to confirm once — then get out of the way for the rest of the thread.
 *
 * The parent calls `guard(threadId, state, action)`:
 *   - state !== 'failed'  → the action runs immediately (no interstitial);
 *   - already confirmed for that thread → runs immediately;
 *   - otherwise → shows the confirm; "Reply anyway" runs the stashed action and
 *     remembers the thread so we never ask again for it.
 *
 * The guard is transparent: it never blocks reply for verified/unknown senders,
 * and it does not touch DMARC→Spam routing — that stays server-side.
 */
import type { SenderAuthState } from '~/utils/senderAuth';

const open = ref(false);
const confirmed = ref<Set<string>>(new Set());
let pending: (() => void) | null = null;

function guard(threadId: string, state: SenderAuthState | null, action: () => void) {
	if (state !== 'failed' || confirmed.value.has(threadId)) {
		action();
		return;
	}
	pending = () => {
		const next = new Set(confirmed.value);
		next.add(threadId);
		confirmed.value = next;
		action();
	};
	open.value = true;
}

function proceed() {
	const run = pending;
	pending = null;
	open.value = false;
	run?.();
}

function cancel() {
	pending = null;
	open.value = false;
}

defineExpose({ guard });
</script>

<template>
	<UiModal
		:open="open"
		title="This sender couldn't be verified"
		size="sm"
		@update:open="
			(v: boolean) => {
				if (!v) cancel();
			}
		"
	>
		<div class="flex items-start gap-3">
			<Icon name="lucide:shield-x" class="w-5 h-5 text-error flex-shrink-0 mt-0.5" />
			<p class="text-sm text-text-secondary">
				This message failed its sender authentication checks, so it may not really be from who it
				claims. If you reply, your response goes to whoever actually sent it. Reply anyway?
			</p>
		</div>
		<div class="mt-4 flex justify-end gap-2">
			<button type="button" class="btn btn-ghost" data-testid="reply-guard-cancel" @click="cancel">
				Cancel
			</button>
			<button
				type="button"
				class="btn btn-primary"
				data-testid="reply-guard-confirm"
				@click="proceed"
			>
				Reply anyway
			</button>
		</div>
	</UiModal>
</template>
