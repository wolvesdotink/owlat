<script setup lang="ts">
/**
 * Toolbar actions for the transactional email editor — the lifecycle cluster
 * that lives in the builder's `#toolbar-actions` slot: the status pill, the
 * share-links popover, the translations jump, and the publish affordance.
 *
 * `pending_review` is a first-class state here, not a variant of draft: the
 * content scanner flagged the publish, so the template is NOT sendable until an
 * admin approves it. That is why the pill has its own tone and the primary
 * action becomes a disabled, honest control rather than "Publish" — there is no
 * author-side action that moves it forward.
 */
import type { Id } from '@owlat/api/dataModel';

defineProps<{
	/** The email being edited; the share-links popover scopes itself to it. */
	emailId: Id<'transactionalEmails'>;
	/** Published — sendable; the publish control flips to Unpublish. */
	isPublished: boolean;
	/** Awaiting admin review after a flagged publish — NOT sendable. */
	isPendingReview: boolean;
	/** A publish/unpublish round-trip is in flight. */
	isPublishing: boolean;
	/** Unsaved editor changes, so share links can warn before handing out a URL. */
	hasChanges: boolean;
}>();

const emit = defineEmits<{
	/** Publish, or unpublish when already published. */
	'toggle-publish': [];
	/** Open the per-language translation manager for this email. */
	translations: [];
}>();

const { t } = useI18n();
</script>

<template>
	<!-- Current lifecycle status — draft / awaiting review / published.
	     `pending_review` is shown distinctly so the author knows the
	     template is NOT sendable yet (the send API rejects it). -->
	<span
		:class="[
			'inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium',
			isPublished
				? 'bg-success/10 text-success'
				: isPendingReview
					? 'bg-warning/10 text-warning'
					: 'bg-text-tertiary/10 text-text-tertiary',
		]"
		:title="
			isPublished
				? t('dashboard.send.transactional.detail.edit.statusHint.published')
				: isPendingReview
					? t('dashboard.send.transactional.detail.edit.statusHint.pendingReview')
					: t('dashboard.send.transactional.detail.edit.statusHint.draft')
		"
	>
		<Icon
			:name="
				isPublished ? 'lucide:check-circle' : isPendingReview ? 'lucide:clock-3' : 'lucide:pencil'
			"
			class="w-3.5 h-3.5"
		/>
		{{
			isPublished
				? t('dashboard.send.transactional.detail.edit.status.published')
				: isPendingReview
					? t('dashboard.send.transactional.detail.edit.status.pendingReview')
					: t('dashboard.send.transactional.detail.edit.status.draft')
		}}
	</span>
	<ShareLinksPopover :transactional-email-id="emailId" :has-unsaved-changes="hasChanges" />
	<UiButton
		variant="outline"
		size="sm"
		:title="t('dashboard.send.transactional.detail.edit.manageTranslations')"
		@click="emit('translations')"
	>
		<template #iconLeft>
			<Icon name="lucide:languages" class="w-4 h-4" />
		</template>
		{{ t('dashboard.send.transactional.detail.edit.translations') }}
	</UiButton>
	<!-- Awaiting review — no author-side action moves this forward, so the
	     primary action is a disabled, honest state rather than "Publish". -->
	<UiButton
		v-if="isPendingReview"
		variant="secondary"
		size="sm"
		disabled
		:title="t('dashboard.send.transactional.detail.edit.pendingReviewButtonHint')"
	>
		<template #iconLeft>
			<Icon name="lucide:clock-3" class="w-4 h-4" />
		</template>
		{{ t('dashboard.send.transactional.detail.edit.status.pendingReview') }}
	</UiButton>
	<!-- Publish / Unpublish — the only affordance that makes a transactional
	     email sendable; without it the send API rejects every request. -->
	<UiButton
		v-else
		:variant="isPublished ? 'secondary' : 'primary'"
		size="sm"
		:loading="isPublishing"
		:title="
			isPublished
				? t('dashboard.send.transactional.detail.edit.publishHint.unpublish')
				: t('dashboard.send.transactional.detail.edit.publishHint.publish')
		"
		@click="emit('toggle-publish')"
	>
		<template v-if="!isPublishing" #iconLeft>
			<Icon :name="isPublished ? 'lucide:rotate-ccw' : 'lucide:rocket'" class="w-4 h-4" />
		</template>
		{{
			isPublished
				? t('dashboard.send.transactional.detail.edit.unpublish')
				: t('dashboard.send.transactional.detail.edit.publish')
		}}
	</UiButton>
</template>
