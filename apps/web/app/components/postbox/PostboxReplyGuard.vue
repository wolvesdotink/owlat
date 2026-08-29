<script setup lang="ts">
/**
 * Reply interstitial for a message whose SENDER is in one of the shapes a reply
 * walks straight into (Sealed Mail A3, widened by UX plan idea 56).
 *
 * It used to fire on `failed` alone. Business email compromise rarely fails
 * DMARC: it passes for a domain that isn't the one on the From line
 * (`misaligned`), or it comes from a domain that LOOKS like a contact's
 * (`lookalikeOfContactDomain`), or it asks for replies at a different domain
 * than it claims to be from (`isReplyToMismatch`). `deriveReplyRisk` covers all
 * four, so the guard now covers them too.
 *
 * The parent calls `guard(threadId, risk, destination, action)`:
 *   - risk === null → the action runs immediately (no interstitial);
 *   - already confirmed for that thread → runs immediately;
 *   - otherwise → shows the confirm, naming the address the reply would ACTUALLY
 *     go to and every reason we have; "Reply anyway" runs the stashed action and
 *     remembers the thread so we never ask again for it.
 *
 * The guard is transparent: it never blocks a reply to an ordinary sender, and
 * it does not touch DMARC→Spam routing — that stays server-side.
 */
import type { ReplyRisk, SenderAuthText } from '~/utils/senderAuth';

const { t } = useI18n();

const open = ref(false);
const confirmed = ref<Set<string>>(new Set());
const risk = ref<ReplyRisk | null>(null);
/**
 * The address the reply would actually be addressed to. Shown verbatim: naming
 * it is the whole point of the interstitial on the impersonation shapes, where
 * the display name is exactly what the reader has been reading all along.
 */
const destination = ref('');
let pending: (() => void) | null = null;

/** The risk lines are catalog keys (module-scope registry), resolved here. */
function line(text: SenderAuthText): string {
	return typeof text === 'string' ? t(text) : t(text.key, text.params ?? {});
}

function guard(
	threadId: string,
	replyRisk: ReplyRisk | null,
	replyDestination: string,
	action: () => void
) {
	if (!replyRisk || confirmed.value.has(threadId)) {
		action();
		return;
	}
	risk.value = replyRisk;
	destination.value = replyDestination;
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
		:title="t('components.postbox.postboxReplyGuard.title')"
		size="sm"
		@update:open="
			(v: boolean) => {
				if (!v) cancel();
			}
		"
	>
		<div class="flex items-start gap-3">
			<Icon name="lucide:shield-alert" class="w-5 h-5 text-error flex-shrink-0 mt-0.5" />
			<div class="min-w-0">
				<p class="text-sm text-text-secondary">
					{{ t('components.postbox.postboxReplyGuard.body') }}
				</p>
				<ul
					v-if="risk"
					class="mt-2 space-y-1 text-sm text-text-secondary list-disc pl-4"
					data-testid="reply-guard-reasons"
				>
					<li v-for="(text, i) in risk.lines" :key="i">{{ line(text) }}</li>
				</ul>
				<p
					v-if="destination"
					class="mt-3 text-sm text-text-primary break-all"
					data-testid="reply-guard-destination"
				>
					{{ t('components.postbox.postboxReplyGuard.destination', { address: destination }) }}
				</p>
			</div>
		</div>
		<div class="mt-4 flex justify-end gap-2">
			<UiButton variant="ghost" type="button" data-testid="reply-guard-cancel" @click="cancel">
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton type="button" data-testid="reply-guard-confirm" @click="proceed">
				{{ t('components.postbox.postboxReplyGuard.replyAnyway') }}
			</UiButton>
		</div>
	</UiModal>
</template>
