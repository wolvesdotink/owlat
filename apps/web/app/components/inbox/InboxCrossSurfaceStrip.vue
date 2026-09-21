<script setup lang="ts">
/**
 * The mirror of PostboxCrossSurfaceStrip (idea 31), on the Team Inbox side:
 * "Also in marcel@… — Postbox · already answered".
 *
 * Same read-only correlation on the RFC 5322 Message-ID, same both-sides
 * permission rule enforced server-side, and the same job: a teammate about to
 * draft a shared reply should be able to see that the message also sits in
 * someone's personal mailbox — and whether it has already been answered there.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{ inboundMessageId: string }>();

const { t } = useI18n();

const { data } = useConvexQuery(api.mail.crossSurface.postboxFor, () =>
	props.inboundMessageId
		? { inboundMessageId: props.inboundMessageId as Id<'inboundMessages'> }
		: 'skip'
);

const link = computed(() =>
	data.value
		? `/dashboard/postbox/${data.value.folderRole ?? 'inbox'}/${String(data.value.messageId)}`
		: ''
);
</script>

<template>
	<aside
		v-if="data"
		class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-border-subtle bg-bg-surface px-3 py-2 text-sm"
	>
		<Icon name="lucide:inbox" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
		<span class="text-text-secondary">{{
			t('components.inbox.inboxCrossSurfaceStrip.alsoInPostbox', {
				mailbox: data.mailboxAddress,
			})
		}}</span>
		<!-- The one fact that changes what a teammate should do next. -->
		<span v-if="data.isAnswered" class="text-warning">{{
			t('components.inbox.inboxCrossSurfaceStrip.alreadyAnswered')
		}}</span>
		<NuxtLink :to="link" class="ml-auto text-brand hover:underline">
			{{ t('components.inbox.inboxCrossSurfaceStrip.open') }}
		</NuxtLink>
	</aside>
</template>
