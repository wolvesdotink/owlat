<script setup lang="ts">
/**
 * "Senders whose images load automatically" — the revocable management list
 * behind the reader's "Always for this sender" button.
 *
 * A permission that can be granted from a banner and never taken back is not a
 * permission, it is a trap, so every grant is listed here with a Revoke beside
 * it. Scoped to the current mailbox, which is what the grant itself is keyed on.
 *
 * Self-hides when nothing has ever been trusted: an empty card in the settings
 * page teaches nothing, and the feature is discovered from the reader.
 */
const { t } = useI18n();

const { currentMailbox } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
const { entries, revoke, isSaving } = usePostboxImageAllowlist(mailboxId);
</script>

<template>
	<section v-if="entries.length > 0" class="card !p-0 mb-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">
				{{ t('components.postbox.postboxTrustedSendersSettings.heading') }}
			</h2>
			<p class="text-xs text-text-tertiary mt-0.5">
				{{ t('components.postbox.postboxTrustedSendersSettings.hint') }}
			</p>
		</header>
		<ul class="divide-y divide-border-subtle">
			<li
				v-for="entry in entries"
				:key="entry._id"
				class="px-5 py-3 flex items-center justify-between gap-3"
			>
				<p class="font-medium text-sm truncate">{{ entry.senderEmail }}</p>
				<UiButton
					variant="secondary"
					size="sm"
					class="shrink-0"
					:disabled="isSaving"
					:aria-label="
						t('components.postbox.postboxTrustedSendersSettings.revokeAriaLabel', {
							sender: entry.senderEmail,
						})
					"
					@click="revoke(entry.senderEmail)"
				>
					{{ t('components.postbox.postboxTrustedSendersSettings.revoke') }}
				</UiButton>
			</li>
		</ul>
	</section>
</template>
