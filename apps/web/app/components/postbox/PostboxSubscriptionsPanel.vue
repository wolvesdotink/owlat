<script setup lang="ts">
/**
 * Subscriptions panel — list-mail hygiene across a whole mailbox.
 *
 * The reader's Unsubscribe chip already handles one message at a time. This is
 * the aggregate: every inbox sender that ships a List-Unsubscribe target, with
 * how much they send and how long ago you last read one of them, multi-select,
 * and one "Unsubscribe and archive" that runs the selection through the same
 * RFC 8058 One-Click flow — sequenced server-side, one sender at a time.
 *
 * Only One-Click senders can be finished here. The rest are listed with a link
 * to their own page instead of being silently dropped or silently failed: the
 * batch never promises what the protocol cannot deliver, and the result summary
 * says exactly which senders still want attention.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	selectableSubscriptionSenders,
	subscriptionBatchSummary,
	subscriptionLastReadMessage,
	summarizeSubscriptionBatch,
	type PostboxSubscriptionOutcome,
	type PostboxSubscriptionSender,
} from '~/utils/postboxSubscriptions';

const props = defineProps<{ mailboxId: Id<'mailboxes'> }>();

const { t } = useI18n();

const { data, isLoading } = useConvexQuery(api.mail.subscriptions.list, () => ({
	mailboxId: props.mailboxId,
}));

const senders = computed<PostboxSubscriptionSender[]>(() => data.value?.senders ?? []);
const truncated = computed(() => data.value?.truncated ?? false);
const scanned = computed(() => data.value?.scanned ?? 0);

// ── Selection ──────────────────────────────────────────────────────────────
// Keyed on the canonical sender address rather than the row index, so a live
// re-sort (new mail lands, volume changes) never moves someone's ticks.
const selected = ref<Set<string>>(new Set());

// Drop selections for senders that left the list (unsubscribed + archived, or
// aged out of the scanned window) so the action button's count stays honest.
watch(senders, (rows) => {
	const live = new Set(rows.map((row) => row.senderEmail));
	const next = new Set([...selected.value].filter((email) => live.has(email)));
	if (next.size !== selected.value.size) selected.value = next;
});

function toggle(senderEmail: string) {
	const next = new Set(selected.value);
	if (next.has(senderEmail)) next.delete(senderEmail);
	else next.add(senderEmail);
	selected.value = next;
}

const oneClickSelection = computed(
	() => selectableSubscriptionSenders(senders.value, selected.value).oneClick
);
const manualSelection = computed(
	() => selectableSubscriptionSenders(senders.value, selected.value).manual
);

/** Select every sender the batch can actually finish. */
function selectAllOneClick() {
	selected.value = new Set(
		senders.value.filter((row) => row.method === 'one-click').map((row) => row.senderEmail)
	);
}

function clearSelection() {
	selected.value = new Set();
}

// ── The batch ──────────────────────────────────────────────────────────────
const batchOp = useBackendOperation(api.mail.subscriptions.unsubscribeAndArchive, {
	label: () => t('components.postbox.postboxSubscriptionsPanel.operation'),
	type: 'action',
});

const results = ref<PostboxSubscriptionOutcome[] | null>(null);
const summary = computed(() =>
	results.value ? subscriptionBatchSummary(summarizeSubscriptionBatch(results.value)) : null
);

async function runBatch() {
	const senderEmails = oneClickSelection.value;
	if (senderEmails.length === 0) return;
	// Unsubscribing is a state-changing request to a third party, times N —
	// never fired without an explicit yes.
	if (
		!window.confirm(
			t('components.postbox.postboxSubscriptionsPanel.confirm', { count: senderEmails.length })
		)
	) {
		return;
	}
	results.value = null;
	const outcome = await batchOp.run({ mailboxId: props.mailboxId, senderEmails });
	if (!outcome.ok) return;
	results.value = outcome.result.results;
	clearSelection();
}

function statusLabel(status: PostboxSubscriptionOutcome['status']): string {
	return t(`components.postbox.postboxSubscriptionsPanel.status.${status}`);
}

const now = Date.now();
function lastReadLabel(sender: PostboxSubscriptionSender): string {
	const message = subscriptionLastReadMessage(sender.lastReadAt, now);
	return t(message.key, message.params, message.params.count);
}
</script>

<template>
	<section class="card !p-0">
		<header class="px-5 py-3 border-b border-border-subtle flex items-center gap-3">
			<div class="min-w-0">
				<h2 class="font-semibold">
					{{ t('components.postbox.postboxSubscriptionsPanel.heading') }}
				</h2>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{
						truncated
							? t('components.postbox.postboxSubscriptionsPanel.windowNote', { count: scanned })
							: t('components.postbox.postboxSubscriptionsPanel.hint')
					}}
				</p>
			</div>
			<span class="flex-1" />
			<span v-if="senders.length > 0" class="text-xs text-text-tertiary shrink-0">
				{{
					t(
						'components.postbox.postboxSubscriptionsPanel.senderCount',
						{ count: senders.length },
						senders.length
					)
				}}
			</span>
		</header>

		<div v-if="isLoading" class="p-8 flex justify-center">
			<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary" />
		</div>
		<div v-else-if="senders.length === 0" class="p-8 text-center">
			<p class="text-text-secondary">
				{{ t('components.postbox.postboxSubscriptionsPanel.empty') }}
			</p>
			<p class="text-xs text-text-tertiary mt-1">
				{{ t('components.postbox.postboxSubscriptionsPanel.emptyHint') }}
			</p>
		</div>

		<template v-else>
			<div
				class="px-5 py-2 border-b border-border-subtle flex items-center gap-3 text-xs text-text-tertiary"
			>
				<button
					type="button"
					class="text-brand font-medium hover:underline"
					@click="selectAllOneClick()"
				>
					{{ t('components.postbox.postboxSubscriptionsPanel.selectAll') }}
				</button>
				<button
					v-if="selected.size > 0"
					type="button"
					class="hover:underline"
					@click="clearSelection()"
				>
					{{ t('components.postbox.postboxSubscriptionsPanel.clearSelection') }}
				</button>
			</div>

			<ul class="divide-y divide-border-subtle">
				<!-- `flex-wrap` + the label's flex-basis floor: on a narrow screen the
				     counts (and the manual "open page" link) wrap under the sender
				     instead of crushing the name column to nothing. -->
				<li
					v-for="sender in senders"
					:key="sender.senderEmail"
					class="px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1"
				>
					<input
						:id="`subscription-${sender.senderEmail}`"
						type="checkbox"
						class="shrink-0 h-4 w-4"
						:checked="selected.has(sender.senderEmail)"
						:disabled="sender.method !== 'one-click'"
						:title="
							sender.method === 'one-click'
								? undefined
								: t('components.postbox.postboxSubscriptionsPanel.manualOnly')
						"
						@change="toggle(sender.senderEmail)"
					/>
					<label
						:for="`subscription-${sender.senderEmail}`"
						class="min-w-0 flex-1 basis-40 cursor-pointer"
					>
						<span class="font-medium text-sm block truncate">{{
							sender.senderName || sender.senderEmail
						}}</span>
						<span class="text-xs text-text-tertiary block truncate">{{ sender.senderEmail }}</span>
					</label>
					<span class="ml-auto text-xs text-text-tertiary shrink-0 text-right">
						{{
							t(
								'components.postbox.postboxSubscriptionsPanel.volume',
								{ count: sender.messageCount },
								sender.messageCount
							)
						}}
						<span class="mx-1">·</span>
						{{ lastReadLabel(sender) }}
					</span>
					<a
						v-if="sender.method !== 'one-click' && sender.httpUrl"
						:href="sender.httpUrl"
						target="_blank"
						rel="noopener noreferrer"
						class="text-xs text-brand hover:underline shrink-0"
					>
						{{ t('components.postbox.postboxSubscriptionsPanel.openPage') }}
					</a>
				</li>
			</ul>

			<footer class="px-5 py-3 border-t border-border-subtle flex items-center gap-3">
				<UiButton
					:disabled="oneClickSelection.length === 0"
					:loading="batchOp.isLoading.value"
					@click="runBatch()"
				>
					{{
						t(
							'components.postbox.postboxSubscriptionsPanel.action',
							{ count: oneClickSelection.length },
							oneClickSelection.length
						)
					}}
				</UiButton>
				<p v-if="manualSelection.length > 0" class="text-xs text-text-tertiary">
					{{
						t(
							'components.postbox.postboxSubscriptionsPanel.manualExcluded',
							{ count: manualSelection.length },
							manualSelection.length
						)
					}}
				</p>
			</footer>
		</template>

		<!-- Partial failure is the normal outcome, so the result is a legible
		     per-sender list rather than a toast that disappears. -->
		<section v-if="results && summary" class="px-5 py-4 border-t border-border-subtle">
			<p
				class="text-sm font-medium"
				:class="{
					'text-success': summary.tone === 'success',
					'text-warning': summary.tone === 'warning',
					'text-error': summary.tone === 'error',
				}"
			>
				{{ t(summary.lines[0]!.key, { count: summary.lines[0]!.count }, summary.lines[0]!.count) }}
			</p>
			<ul class="mt-1 text-xs text-text-secondary">
				<li v-for="line in summary.lines.slice(1)" :key="line.key">
					{{ t(line.key, { count: line.count }, line.count) }}
				</li>
			</ul>
			<ul class="mt-3 divide-y divide-border-subtle border-t border-border-subtle">
				<li
					v-for="result in results"
					:key="result.senderEmail"
					class="py-2 flex items-center gap-3 text-xs"
				>
					<span class="min-w-0 flex-1 truncate">{{ result.senderEmail }}</span>
					<span
						class="shrink-0"
						:class="result.status === 'unsubscribed' ? 'text-success' : 'text-text-tertiary'"
					>
						{{ statusLabel(result.status) }}
					</span>
					<a
						v-if="result.status === 'manual' && result.httpUrl"
						:href="result.httpUrl"
						target="_blank"
						rel="noopener noreferrer"
						class="text-brand hover:underline shrink-0"
					>
						{{ t('components.postbox.postboxSubscriptionsPanel.openPage') }}
					</a>
				</li>
			</ul>
		</section>
	</section>
</template>
