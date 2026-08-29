<script setup lang="ts">
/**
 * "Files you shared as links" — the revocation list behind the composer's
 * "Share as link instead" (idea 10).
 *
 * A link created in a hurry inside a draft is handed to someone outside the
 * company and then forgotten. This card is the only place it can be found
 * again, so it shows the whole history, not just what is still live: the
 * question people arrive with is "the download stopped working, what happened?"
 * and an expired row that says so answers it in two seconds.
 *
 * Two different undos, deliberately kept apart:
 *   - REVOKE deletes the file. It is confirmed, because it is not reversible.
 *   - LIMIT TO MY MAILBOX kills the public URL and keeps the file. It is the
 *     "I sent that to the wrong person" move and needs no confirmation, because
 *     nothing is lost by pressing it.
 *
 * Self-hides until this person has shared something: an empty card in a
 * settings page teaches nothing, and the feature is discovered in the composer.
 */
import type { Id } from '@owlat/api/dataModel';
import { ATTACHMENT_SHARE_EXPIRY_DAY_CHOICES } from '@owlat/shared/attachmentShares';
import {
	postboxShareLinkScopeKey,
	postboxShareLinkStatusKey,
	postboxShareLinkSummary,
} from '~/utils/postboxShareLink';

const { t } = useI18n();

const { currentMailbox } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
const { shares, revoke, setScope, openOwnCopy, isSaving } = usePostboxAttachmentShares(mailboxId);
const { shareLinkExpiryDays, setShareLinkExpiryDays } = usePostboxSettings();
const { copy, isCopied } = useCopyToClipboard();

type ShareRow = (typeof shares.value)[number];

const revokeTarget = ref<ShareRow | null>(null);

function summaryFor(row: ShareRow): string {
	const message = postboxShareLinkSummary(row.state, row.downloadCount);
	return t(message.key, message.params ?? {});
}

async function confirmRevoke() {
	const target = revokeTarget.value;
	if (!target) return;
	await revoke(target._id as Id<'mailAttachmentShares'>);
	revokeTarget.value = null;
}
</script>

<template>
	<section v-if="shares.length > 0" id="shared-links" class="card !p-0 mb-6 scroll-mt-6">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 class="font-semibold">
				{{ t('components.postbox.postboxSharedLinksSettings.heading') }}
			</h2>
			<p class="text-xs text-text-tertiary mt-0.5">
				{{ t('components.postbox.postboxSharedLinksSettings.hint') }}
			</p>
		</header>

		<ul class="divide-y divide-border-subtle">
			<!-- `flex-wrap` + the filename block's flex-basis floor: on a narrow
			     screen the status chip and action buttons wrap under the filename
			     instead of crushing it and running past the viewport. -->
			<li
				v-for="row in shares"
				:key="row._id"
				class="px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-2"
			>
				<div class="min-w-0 flex-1 basis-48">
					<p class="font-medium text-sm truncate">{{ row.filename }}</p>
					<p class="text-xs text-text-tertiary">
						{{ formatCompactFileSize(row.size) }} · {{ t(postboxShareLinkScopeKey(row.scope)) }} ·
						{{ summaryFor(row) }}
					</p>
				</div>

				<span
					class="text-xs px-2 py-0.5 rounded shrink-0"
					:class="
						row.state === 'live'
							? 'bg-success-subtle text-success'
							: 'bg-bg-surface text-text-tertiary'
					"
					>{{ t(postboxShareLinkStatusKey(row.state)) }}</span
				>

				<div class="ml-auto flex items-center gap-2 shrink-0">
					<!-- Only offered while the URL would actually resolve; the server
					     withholds it otherwise, so there is nothing to copy. -->
					<UiButton
						v-if="row.publicUrl"
						variant="secondary"
						size="sm"
						@click="copy(row.publicUrl, row._id)"
					>
						{{
							isCopied(row._id)
								? t('components.postbox.postboxSharedLinksSettings.copied')
								: t('components.postbox.postboxSharedLinksSettings.copy')
						}}
					</UiButton>
					<UiButton
						v-if="row.publicUrl"
						variant="secondary"
						size="sm"
						:disabled="isSaving"
						:title="t('components.postbox.postboxSharedLinksSettings.limitTitle')"
						:aria-label="
							t('components.postbox.postboxSharedLinksSettings.limitAriaLabel', {
								filename: row.filename,
							})
						"
						@click="setScope(row._id as Id<'mailAttachmentShares'>, 'mailbox')"
					>
						{{ t('components.postbox.postboxSharedLinksSettings.limit') }}
					</UiButton>
					<!-- The file survives a narrowing, so the owner keeps a way in even
					     once the public URL is gone. -->
					<UiButton
						v-if="row.hasBytes && !row.publicUrl"
						variant="secondary"
						size="sm"
						:aria-label="
							t('components.postbox.postboxSharedLinksSettings.openAriaLabel', {
								filename: row.filename,
							})
						"
						@click="openOwnCopy(row._id as Id<'mailAttachmentShares'>)"
					>
						{{ t('components.postbox.postboxSharedLinksSettings.open') }}
					</UiButton>
					<UiButton
						v-if="row.state === 'live'"
						variant="secondary"
						size="sm"
						:disabled="isSaving"
						:aria-label="
							t('components.postbox.postboxSharedLinksSettings.revokeAriaLabel', {
								filename: row.filename,
							})
						"
						@click="revokeTarget = row"
					>
						{{ t('components.postbox.postboxSharedLinksSettings.revoke') }}
					</UiButton>
				</div>
			</li>
		</ul>

		<footer class="px-5 py-3 border-t border-border-subtle flex items-center gap-2">
			<label for="share-link-expiry" class="text-sm text-text-secondary">
				{{ t('components.postbox.postboxSharedLinksSettings.expiryLabel') }}
			</label>
			<select
				id="share-link-expiry"
				class="input w-36"
				:value="shareLinkExpiryDays"
				@change="
					setShareLinkExpiryDays(
						Number(($event.target as HTMLSelectElement).value) as typeof shareLinkExpiryDays
					)
				"
			>
				<option v-for="days in ATTACHMENT_SHARE_EXPIRY_DAY_CHOICES" :key="days" :value="days">
					{{ t('components.postbox.postboxSharedLinksSettings.expiryDays', { days }) }}
				</option>
			</select>
			<span class="text-xs text-text-tertiary">
				{{ t('components.postbox.postboxSharedLinksSettings.expiryHint') }}
			</span>
		</footer>

		<UiConfirmationDialog
			:open="!!revokeTarget"
			variant="danger"
			:title="t('components.postbox.postboxSharedLinksSettings.revoke')"
			:description="
				t('components.postbox.postboxSharedLinksSettings.revokeDescription', {
					filename: revokeTarget?.filename ?? '',
				})
			"
			:confirm-text="t('components.postbox.postboxSharedLinksSettings.revoke')"
			:is-loading="isSaving"
			@update:open="
				(v: boolean) => {
					if (!v) revokeTarget = null;
				}
			"
			@confirm="confirmRevoke"
		/>
	</section>
</template>
