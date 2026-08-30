<script setup lang="ts">
/**
 * The bulk bar's ⋯ overflow — the composer's rule applied to the selection.
 *
 * Read, Star, Archive, Delete and Move stay on the bar; the five verbs nobody
 * reaches for daily live here: Label, Snooze (Unsnooze in the snoozed folder),
 * Spam (Not spam in Spam), Unsubscribe-and-archive, and Delete forever (Trash
 * only). Every contextual swap the visible bar used to carry is preserved, and
 * the One-Click gating of Unsubscribe with it — the query that gates it lives
 * here, not in the panel, so the item is never a dead button and never a
 * surprise appearance.
 *
 * The label picker expands INSIDE the panel rather than opening a second
 * popover: a dropdown hanging off a dropdown is unreachable by keyboard on
 * touch and closes its own parent on the way out.
 *
 * The snooze dialog is deliberately a sibling of the menu, not slot content:
 * PostboxOverflowMenu unmounts its panel when it closes, and a dialog whose
 * state lived in there would vanish with the click that opened it.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { subscriptionBatchSummary, summarizeSubscriptionBatch } from '~/utils/postboxSubscriptions';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	folderRole?: string;
}>();

const { t } = useI18n();
const { showToast } = useToast();

const mailboxIdRef = computed(() => props.mailboxId);
const bulk = usePostboxBulkActions(mailboxIdRef);
const { labels } = usePostboxLabels(mailboxIdRef);

const labelsOpen = ref(false);
const snoozeOpen = ref(false);

// Label / snooze / unsnooze are ONE mutation over the whole selection, like
// every other verb in this bar. They used to loop the single-message mutation
// per selected row: a 200-message selection meant 200 round trips, 200 live
// re-renders, and a failure halfway through left the selection half-applied
// with nothing able to name where it stopped.
const setLabelOnSelection = useBackendOperation(api.mail.labels.setOnMessages, {
	label: () => t('components.postbox.postboxQuickActionsBar.operations.label'),
});
const snoozeMutation = useBackendOperation(api.mail.snooze.snoozeMany, {
	label: () => t('components.postbox.postboxQuickActionsBar.operations.snooze'),
});
const unsnoozeMutation = useBackendOperation(api.mail.snooze.unsnoozeMany, {
	label: () => t('components.postbox.postboxQuickActionsBar.operations.unsnooze'),
});

async function applyLabel(labelId: Id<'mailLabels'>) {
	labelsOpen.value = false;
	if (bulk.ids.value.length === 0) return;
	await setLabelOnSelection.run({ messageIds: bulk.ids.value, labelId, add: true });
}

async function snoozeSelected(until: number) {
	if (bulk.ids.value.length === 0) return;
	const result = await snoozeMutation.run({ messageIds: bulk.ids.value, until });
	if (!result.ok) return;
	bulk.clear();
}

async function unsnoozeSelected() {
	if (bulk.ids.value.length === 0) return;
	const result = await unsnoozeMutation.run({ messageIds: bulk.ids.value });
	if (!result.ok) return;
	bulk.clear();
}

// Unsubscribe + archive, for whatever list mail is in the selection. The
// selected ROWS collapse to their distinct senders server-side (a selection of
// six newsletters is usually two or three publishers), and each sender comes
// back paired with the message the POST should use, so the action operates on
// exactly the rows the verb was offered for — including rows in Archive, Spam
// or a label view, which the subscriptions panel's inbox window never sees.
//
// Only One-Click senders come back, so the item self-hides when the selection
// holds nothing this verb can finish: a page-only or mailto-only newsletter is
// left to the reader's own unsubscribe chip rather than being promised here.
const { data: selectionSenders } = useConvexQuery(api.mail.subscriptions.sendersOfMessages, () =>
	bulk.ids.value.length > 0 ? { mailboxId: props.mailboxId, messageIds: bulk.ids.value } : 'skip'
);
const unsubscribableSenders = computed(() => selectionSenders.value ?? []);

const unsubscribeOp = useBackendOperation(api.mail.subscriptions.unsubscribeAndArchive, {
	label: () => t('components.postbox.postboxQuickActionsBar.operations.unsubscribe'),
	type: 'action',
});

async function unsubscribeSelected() {
	const senderEmails = unsubscribableSenders.value.map((sender) => sender.senderEmail);
	if (senderEmails.length === 0) return;
	// N state-changing POSTs at third parties — always behind an explicit yes.
	if (
		!window.confirm(
			t(
				'components.postbox.postboxQuickActionsBar.unsubscribeConfirm',
				{ count: senderEmails.length },
				senderEmails.length
			)
		)
	) {
		return;
	}
	const outcome = await unsubscribeOp.run({
		mailboxId: props.mailboxId,
		senderEmails,
		messageIds: bulk.ids.value,
	});
	if (!outcome.ok) return;
	// Every line, not just the headline: "2 unsubscribed" alone hides the 148
	// archived and the one that still needs finishing by hand.
	const summary = subscriptionBatchSummary(summarizeSubscriptionBatch(outcome.result.results));
	const message = summary.lines
		.map((line) => t(line.key, { count: line.count }, line.count))
		.join(' · ');
	if (message) showToast(message, summary.tone);
	bulk.clear();
}

// Permanent delete is irreversible (frees the raw .eml + body blobs), so guard
// it behind a confirm. Only offered from Trash, where "Delete" already means
// "remove for good" rather than "move to Trash".
async function purgeSelected() {
	const n = bulk.count.value;
	if (n === 0) return;
	if (!window.confirm(t('components.postbox.postboxQuickActionsBar.purgeConfirm', { count: n }, n)))
		return;
	await bulk.purgeSelected();
}

/** One string, so five near-identical items cannot drift apart. */
const ITEM_CLASS =
	'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left whitespace-nowrap text-text-primary hover:bg-bg-surface';
</script>

<template>
	<div class="inline-flex">
		<PostboxOverflowMenu :label="t('components.postbox.postboxQuickActionsBar.moreActions')">
			<template #default="{ close }">
				<!-- Label: expands in place, so the panel stays the one surface. -->
				<button
					type="button"
					role="menuitem"
					:aria-expanded="labelsOpen"
					:class="ITEM_CLASS"
					@click="labelsOpen = !labelsOpen"
				>
					<Icon name="lucide:tag" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
					{{ t('components.postbox.postboxQuickActionsBar.label') }}
					<Icon
						:name="labelsOpen ? 'lucide:chevron-up' : 'lucide:chevron-down'"
						class="w-3.5 h-3.5 ml-auto text-text-tertiary"
						aria-hidden="true"
					/>
				</button>
				<div v-if="labelsOpen" class="max-h-48 overflow-auto">
					<button
						v-for="label in labels"
						:key="label._id"
						type="button"
						role="menuitem"
						:class="[ITEM_CLASS, 'pl-9']"
						@click="
							applyLabel(label._id);
							close();
						"
					>
						<span
							class="w-2.5 h-2.5 rounded-full flex-shrink-0"
							:style="{ backgroundColor: label.color || 'var(--color-text-tertiary)' }"
						/>
						{{ label.name }}
					</button>
					<p v-if="labels.length === 0" class="px-3 py-2 pl-9 text-xs text-text-tertiary">
						{{ t('components.postbox.postboxQuickActionsBar.noLabels') }}
					</p>
				</div>
				<div class="my-1 border-t border-border-subtle" />
				<!-- Snooze, or its swap in the folder snoozing put them in. -->
				<button
					v-if="props.folderRole !== 'snoozed'"
					type="button"
					role="menuitem"
					:class="ITEM_CLASS"
					:title="t('components.postbox.postboxQuickActionsBar.snoozeTitle')"
					@click="
						snoozeOpen = true;
						close();
					"
				>
					<Icon name="lucide:clock" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
					{{ t('components.postbox.postboxQuickActionsBar.snooze') }}
				</button>
				<button
					v-else
					type="button"
					role="menuitem"
					:class="ITEM_CLASS"
					:title="t('components.postbox.postboxQuickActionsBar.unsnoozeTitle')"
					@click="
						unsnoozeSelected();
						close();
					"
				>
					<Icon name="lucide:alarm-clock-off" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
					{{ t('components.postbox.postboxQuickActionsBar.unsnooze') }}
				</button>
				<!-- Spam, or its swap in Spam itself. -->
				<button
					v-if="props.folderRole === 'spam'"
					type="button"
					role="menuitem"
					:class="ITEM_CLASS"
					:title="t('components.postbox.postboxQuickActionsBar.notSpamTitle')"
					@click="
						bulk.notSpamSelected();
						close();
					"
				>
					<Icon name="lucide:shield-check" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
					{{ t('components.postbox.postboxQuickActionsBar.notSpam') }}
				</button>
				<button
					v-else
					type="button"
					role="menuitem"
					:class="ITEM_CLASS"
					:title="t('components.postbox.postboxQuickActionsBar.spamTitle')"
					@click="
						bulk.reportSpamSelected();
						close();
					"
				>
					<Icon name="lucide:shield-alert" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
					{{ t('components.postbox.postboxQuickActionsBar.spam') }}
				</button>
				<!-- Unsubscribe + archive: only offered when the selection actually
				     holds One-Click list mail, so it is never a dead item. -->
				<button
					v-if="unsubscribableSenders.length > 0"
					type="button"
					role="menuitem"
					:class="ITEM_CLASS"
					:disabled="unsubscribeOp.isLoading.value"
					:title="
						t(
							'components.postbox.postboxQuickActionsBar.unsubscribeTitle',
							{ count: unsubscribableSenders.length },
							unsubscribableSenders.length
						)
					"
					@click="
						unsubscribeSelected();
						close();
					"
				>
					<Icon name="lucide:bell-off" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
					{{ t('components.postbox.postboxQuickActionsBar.unsubscribe') }}
				</button>
				<!-- Delete forever: Trash only, where "delete" already happened once. -->
				<template v-if="props.folderRole === 'trash'">
					<div class="my-1 border-t border-border-subtle" />
					<button
						type="button"
						role="menuitem"
						:class="[ITEM_CLASS, 'text-error hover:bg-error/10']"
						:title="t('components.postbox.postboxQuickActionsBar.deleteForeverTitle')"
						@click="
							purgeSelected();
							close();
						"
					>
						<Icon name="lucide:trash-2" class="w-4 h-4 flex-shrink-0" />
						{{ t('components.postbox.postboxQuickActionsBar.deleteForever') }}
					</button>
				</template>
			</template>
		</PostboxOverflowMenu>
		<PostboxSnoozeDialog
			:open="snoozeOpen"
			@update:open="snoozeOpen = $event"
			@confirm="snoozeSelected"
		/>
	</div>
</template>
