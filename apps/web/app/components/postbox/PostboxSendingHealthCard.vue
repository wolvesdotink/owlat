<script setup lang="ts">
/**
 * "Is my mail arriving?" — the member-readable sending-health card (plan idea
 * 12), in Postbox preferences.
 *
 * Every existing answer to that question lives behind the admin hub: the
 * delivery readiness panel, the deliverability dashboard, Postmaster data. A
 * member whose mail quietly lands in spam, or bounces outright, has had no
 * signal at all. This card gives them one from data they are already allowed to
 * read — their own send-as identity's verification + transport alignment
 * (`listSendAsIdentities`, mailbox-scoped) and their own recent sends
 * (`mailbox.queries.sendingHealth`, over their sent folder).
 *
 * Nothing here is org-wide or admin-gated, and the card deliberately offers no
 * fix links: a member cannot open `/dashboard/admin/delivery/*`, so pointing
 * them there would be a dead end. The next step is a sentence they can act on or
 * forward to whoever runs the instance. `ReadinessPanel.vue` documents the
 * member-readable precedent this follows.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { healthChipClass, healthTextClass } from '~/utils/healthTone';
import { selectedSenderIdentity } from '~/utils/senderAlignment';
import {
	deriveSendingHealth,
	type SendingHealthIdentity,
	type SendingHealthStats,
} from '~/utils/postboxSendingHealth';
import type { LocalizedText, ReadinessGateStatus } from '~/utils/readinessGate';

const { t } = useI18n();
const { currentMailbox } = usePostboxMailbox();

const mailboxId = computed(() => (currentMailbox.value?._id ?? null) as Id<'mailboxes'> | null);

const { data: identities, isLoading: identitiesLoading } = useConvexQuery(
	api.mail.identities.listSendAsIdentities,
	() => (mailboxId.value ? { mailboxId: mailboxId.value } : 'skip')
);

const { data: stats, isLoading: statsLoading } = useConvexQuery(
	api.mail.mailbox.queries.sendingHealth,
	() => (mailboxId.value ? { mailboxId: mailboxId.value } : 'skip')
);

/**
 * The identity this member actually sends as: the mailbox's own address, via the
 * same picker helper the composer's From control uses, so the card cannot report
 * on a different identity than the one a send would go out under.
 */
const identity = computed<SendingHealthIdentity | null>(() =>
	selectedSenderIdentity(identities.value ?? [], currentMailbox.value?.address ?? '')
);

const isLoading = computed(
	() => !mailboxId.value || identitiesLoading.value || statsLoading.value
);

const health = computed(() =>
	deriveSendingHealth({
		identity: identity.value,
		stats: (stats.value ?? null) as SendingHealthStats | null,
	})
);

function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

const GATE_ICON: Record<ReadinessGateStatus, string> = {
	ready: 'lucide:check-circle-2',
	attention: 'lucide:alert-circle',
	pending: 'lucide:clock',
};
</script>

<template>
	<section class="card !p-0 mb-6" aria-labelledby="postbox-sending-health-heading">
		<header class="px-5 py-3 border-b border-border-subtle">
			<h2 id="postbox-sending-health-heading" class="font-semibold">
				{{ t('components.postbox.postboxSendingHealthCard.heading') }}
			</h2>
		</header>

		<div v-if="isLoading" class="px-5 py-4 space-y-3" aria-busy="true">
			<div class="h-4 w-48 rounded bg-bg-surface animate-pulse" />
			<div v-for="n in 3" :key="n" class="h-8 rounded bg-bg-surface animate-pulse" />
		</div>

		<div v-else class="px-5 py-4 space-y-4">
			<!-- The verdict, then the one thing to do about it. -->
			<div class="flex items-start gap-2.5 flex-wrap">
				<span
					class="px-2.5 py-1 rounded-full text-xs font-medium shrink-0"
					:class="healthChipClass[health.tone]"
				>
					{{ localized(health.headline) }}
				</span>
				<p class="text-sm text-text-secondary flex-1 min-w-48">
					{{ localized(health.nextStep) }}
				</p>
			</div>

			<ul class="space-y-2">
				<li
					v-for="gate in health.gates"
					:key="gate.key"
					class="flex items-start gap-2.5 rounded-lg bg-bg-surface px-3 py-2.5"
				>
					<Icon
						:name="GATE_ICON[gate.status]"
						class="w-4 h-4 mt-0.5 shrink-0"
						:class="healthTextClass[gate.tone]"
					/>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-medium text-text-primary">{{ localized(gate.title) }}</p>
						<p class="text-xs text-text-secondary mt-0.5">{{ localized(gate.detail) }}</p>
					</div>
				</li>
			</ul>

			<!-- A share, only once there are enough attempts for a share to mean
			     anything; below that the gate above already reports the raw counts. -->
			<p v-if="health.ratio" class="text-xs text-text-tertiary">
				{{
					t('components.postbox.postboxSendingHealthCard.ratio', {
						failures: health.ratio.failures,
						attempts: health.ratio.attempts,
					})
				}}
			</p>
		</div>
	</section>
</template>
