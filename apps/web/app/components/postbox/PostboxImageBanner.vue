<script setup lang="ts">
/**
 * The one strip above a rendered mail body that says what the reader is
 * withholding and offers the ways out of it.
 *
 * Split from `PostboxMessageBody` (which owns the sanitize/render pipeline and
 * was over the file-size ceiling) — this is presentation only. Which of the
 * four states applies is decided by `resolvePostboxImageBanner`, so the two
 * halves are testable apart: the choice as a pure function, the wording here.
 *
 * The states, and the promise each one makes:
 *   - `blocked`          remote images are gated. "Show once" is this message;
 *                        "Always for <host>" persists a per-sender grant.
 *   - `auto-allowed`     images loaded because the sender is trusted — said out
 *                        loud, with the revoke and the management list one
 *                        click away, because a silent auto-load is the wrong
 *                        kind of quiet.
 *   - `trackers-blocked` images shown for this message; probable tracking
 *                        pixels withheld.
 *   - `none`             nothing rendered.
 *
 * Across every state, trusting a sender loads IMAGES and never pixels, so
 * "Load everything" stays reachable for a trusted sender too.
 */
import type { PostboxImageBannerState } from '~/utils/postboxImageAllowlist';

defineProps<{
	kind: PostboxImageBannerState['kind'];
	/** Probable tracking pixels found in the sanitized body. */
	trackerCount: number;
	/** A canonical sender address exists, so a grant can be keyed on it. */
	canTrustSender: boolean;
	/** What the grant is named after (the sender's domain). */
	senderLabel: string | null;
}>();

const emit = defineEmits<{
	/** Load remote images for this message only. */
	showOnce: [];
	/** Persist the per-sender grant. */
	trustSender: [];
	/** Drop the per-sender grant. */
	untrustSender: [];
	/** Escalate past tracking-pixel stripping, for this message only. */
	loadEverything: [];
}>();

const { t } = useI18n();

const BANNER_CLASS =
	'mb-2 px-3 py-2 rounded bg-bg-surface text-xs flex items-center justify-between gap-3';
</script>

<template>
	<div v-if="kind === 'blocked'" :class="BANNER_CLASS">
		<span class="text-text-secondary">
			<template v-if="trackerCount > 0">
				{{
					t(
						'components.postbox.postboxMessageBody.imagesBlockedTrackers',
						{ count: trackerCount },
						trackerCount
					)
				}}
			</template>
			<template v-else>
				{{ t('components.postbox.postboxMessageBody.imagesBlocked') }}
			</template>
		</span>
		<span class="flex items-center gap-3 flex-shrink-0">
			<button
				type="button"
				class="text-brand font-medium hover:underline"
				@click="emit('showOnce')"
			>
				{{ t('components.postbox.postboxMessageBody.showOnce') }}
			</button>
			<button
				v-if="canTrustSender"
				type="button"
				class="text-brand font-medium hover:underline"
				:title="t('components.postbox.postboxMessageBody.alwaysForSenderTitle')"
				@click="emit('trustSender')"
			>
				{{ t('components.postbox.postboxMessageBody.alwaysForSender', { host: senderLabel }) }}
			</button>
		</span>
	</div>

	<div v-else-if="kind === 'auto-allowed'" :class="BANNER_CLASS">
		<span class="text-text-secondary inline-flex items-center gap-1.5">
			<Icon name="lucide:shield-check" class="w-3.5 h-3.5 flex-shrink-0" />
			{{ t('components.postbox.postboxMessageBody.imagesAutoLoaded', { host: senderLabel }) }}
		</span>
		<span class="flex items-center gap-3 flex-shrink-0">
			<button
				v-if="trackerCount > 0"
				type="button"
				class="text-text-tertiary font-medium hover:underline"
				@click="emit('loadEverything')"
			>
				{{ t('components.postbox.postboxMessageBody.loadEverything') }}
			</button>
			<button
				type="button"
				class="text-text-tertiary font-medium hover:underline"
				@click="emit('untrustSender')"
			>
				{{ t('components.postbox.postboxMessageBody.stopTrustingSender') }}
			</button>
			<NuxtLink to="/dashboard/preferences" class="text-text-tertiary font-medium hover:underline">
				{{ t('components.postbox.postboxMessageBody.manageTrustedSenders') }}
			</NuxtLink>
		</span>
	</div>

	<div v-else-if="kind === 'trackers-blocked'" :class="BANNER_CLASS">
		<span class="text-text-secondary inline-flex items-center gap-1.5">
			<Icon name="lucide:shield" class="w-3.5 h-3.5 flex-shrink-0" />
			{{
				t(
					'components.postbox.postboxMessageBody.trackersKeptBlocked',
					{ count: trackerCount },
					trackerCount
				)
			}}
		</span>
		<button
			type="button"
			class="text-text-tertiary font-medium hover:underline"
			@click="emit('loadEverything')"
		>
			{{ t('components.postbox.postboxMessageBody.loadEverything') }}
		</button>
	</div>
</template>
