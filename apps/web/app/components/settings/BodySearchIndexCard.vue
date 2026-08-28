<script setup lang="ts">
import { api } from '@owlat/api';

/**
 * Deep body search — the instance switch for the widened plaintext carve-out
 * (idea 32, ADR-0059), on Settings → Sealed Mail because that is the decision
 * it trades against.
 *
 * Message bodies are sealed at rest, and full-text search can only index
 * plaintext. Until this switch, the indexed plaintext was the 200-character
 * snippet; turning it on widens it to a ~8KB excerpt per message, which is what
 * makes a phrase deep inside a long email findable at all. The card states that
 * trade in those terms rather than as a feature name, and it never claims the
 * search is deep before the excerpts actually exist: turning the switch on only
 * starts covering NEW mail, and the operator has to run the backfill for
 * existing mail. The progress strip is that walk.
 *
 * Turning it back off is handled server-side: the update mutation schedules a
 * sweep that clears every excerpt already written.
 */

const { t } = useI18n();
const { canManageOrganization } = usePermissions();
const { showToast } = useToast();

const { data: settings, isLoading } = useConvexQuery(api.workspaces.settings.get, {});
const isEnabled = computed<boolean>(() => settings.value?.isBodySearchIndexingEnabled === true);

// The backfill is per mailbox (it walks one mailbox's messages), so the card
// offers it for the mailbox the admin is themselves working in. Other mailboxes
// are covered by their own owners running the same walk.
const { currentMailbox } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const { data: job } = useConvexQuery(api.mail.bodySearchBackfill.status, () =>
	mailboxId.value ? { mailboxId: mailboxId.value } : 'skip'
);
const isIndexed = computed(() => job.value?.status === 'completed' && job.value?.mode === 'index');
const isWalking = computed(() => job.value?.status === 'running');

const { run: updateSettings, isLoading: isSaving } = useBackendOperation(
	api.workspaces.settings.update,
	{ label: () => t('components.settings.bodySearchIndexCard.updateOperation') }
);
const { run: startBackfill, isLoading: isStarting } = useBackendOperation(
	api.mail.bodySearchBackfill.start,
	{ label: () => t('components.settings.bodySearchIndexCard.backfillOperation') }
);
const { run: cancelBackfill, isLoading: isCancelling } = useBackendOperation(
	api.mail.bodySearchBackfill.cancel,
	{ label: () => t('components.settings.bodySearchIndexCard.cancelOperation') }
);

/** Turning it OFF erases excerpts, so it asks first rather than acting on a click. */
const isConfirmingDisable = ref(false);

async function onToggle(next: boolean) {
	if (!canManageOrganization.value || next === isEnabled.value) return;
	if (!next) {
		isConfirmingDisable.value = true;
		return;
	}
	const res = await updateSettings({ isBodySearchIndexingEnabled: true });
	if (!res.ok) return; // failure already toasted
	showToast(t('components.settings.bodySearchIndexCard.toastOn'));
}

async function confirmDisable() {
	const res = await updateSettings({ isBodySearchIndexingEnabled: false });
	isConfirmingDisable.value = false;
	if (!res.ok) return;
	showToast(t('components.settings.bodySearchIndexCard.toastOff'));
}

async function runBackfill() {
	if (!mailboxId.value) return;
	await startBackfill({ mailboxId: mailboxId.value });
}

async function stopBackfill() {
	if (!mailboxId.value) return;
	await cancelBackfill({ mailboxId: mailboxId.value });
}
</script>

<template>
	<section class="space-y-4 card p-5">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<h2 class="text-base font-semibold text-text-primary">
					{{ t('components.settings.bodySearchIndexCard.title') }}
				</h2>
				<p class="mt-1 text-sm text-text-secondary">
					{{ t('components.settings.bodySearchIndexCard.description') }}
				</p>
				<!-- The honest cost, stated whenever the switch is on. -->
				<p v-if="isEnabled" class="mt-2 text-xs text-warning">
					{{ t('components.settings.bodySearchIndexCard.plaintextWarning') }}
				</p>
				<p v-if="!canManageOrganization" class="mt-2 text-xs text-text-tertiary">
					{{ t('components.settings.bodySearchIndexCard.adminsOnly') }}
				</p>
			</div>
			<UiSpinner v-if="isLoading" size="sm" />
			<UiToggle
				v-else
				:model-value="isEnabled"
				:disabled="!canManageOrganization || isSaving"
				:label="isEnabled ? t('common.enabled') : t('common.disabled')"
				data-testid="body-search-indexing"
				@update:model-value="onToggle"
			/>
		</div>

		<!-- Existing mail. The switch only covers mail delivered from now on, and
		     search deliberately keeps reading the snippet until this walk finishes,
		     so the state is worth naming rather than leaving to be inferred. -->
		<div v-if="isEnabled && mailboxId" class="border-t border-border-subtle pt-4">
			<p class="text-sm text-text-secondary">
				{{ t('components.settings.bodySearchIndexCard.backfillDescription') }}
			</p>
			<div class="mt-3 flex items-center gap-3">
				<template v-if="isWalking">
					<UiSpinner size="sm" />
					<span class="text-sm text-text-secondary" role="status">
						{{
							t('components.settings.bodySearchIndexCard.backfillRunning', {
								count: job?.scannedCount ?? 0,
							})
						}}
					</span>
					<button
						type="button"
						class="text-sm text-text-tertiary hover:text-text-primary"
						:disabled="isCancelling"
						@click="stopBackfill"
					>
						{{ t('common.cancel') }}
					</button>
				</template>
				<template v-else>
					<span v-if="isIndexed" class="text-sm text-success" role="status">
						{{
							t('components.settings.bodySearchIndexCard.backfillDone', {
								count: job?.indexedCount ?? 0,
							})
						}}
					</span>
					<span v-else class="text-sm text-text-tertiary" role="status">
						{{ t('components.settings.bodySearchIndexCard.backfillPending') }}
					</span>
					<button
						type="button"
						class="text-sm text-brand hover:underline disabled:opacity-50"
						:disabled="isStarting"
						data-testid="body-search-backfill-start"
						@click="runBackfill"
					>
						{{
							isIndexed
								? t('components.settings.bodySearchIndexCard.backfillAgain')
								: t('components.settings.bodySearchIndexCard.backfillStart')
						}}
					</button>
				</template>
			</div>
		</div>

		<UiConfirmationDialog
			:open="isConfirmingDisable"
			:title="t('components.settings.bodySearchIndexCard.confirmDisableTitle')"
			:description="t('components.settings.bodySearchIndexCard.confirmDisableDescription')"
			:confirm-text="t('components.settings.bodySearchIndexCard.confirmDisableAction')"
			:is-loading="isSaving"
			@update:open="(v: boolean) => !v && (isConfirmingDisable = false)"
			@confirm="confirmDisable"
			@cancel="isConfirmingDisable = false"
		/>
	</section>
</template>
