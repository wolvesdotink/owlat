<script setup lang="ts">
/**
 * "Also in Team Inbox — assigned to Ana, draft pending" (idea 31).
 *
 * A read-only strip at the top of the Postbox reader for mail that ALSO exists
 * in the Team Inbox. It exists to stop the collision where someone replies
 * personally while a teammate drafts a reply on the shared side, so what it
 * shows is exactly the state that matters for that decision — who owns it and
 * whether a reply is already drafted — and a link across. No body, no draft
 * text, nothing merged.
 *
 * Renders nothing unless the server found a counterpart AND the viewer is
 * permitted on both surfaces; the query withholds the whole answer otherwise,
 * so there is no "something exists but you can't see it" state to render.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{ messageId: string }>();

const { t } = useI18n();

const { data } = useConvexQuery(api.mail.crossSurface.teamInboxFor, () =>
	props.messageId ? { messageId: props.messageId as Id<'mailMessages'> } : 'skip'
);

const link = computed(() =>
	data.value?.threadId ? `/dashboard/inbox/${String(data.value.threadId)}` : '/dashboard/inbox'
);

/** The one detail line: who has it, and whether a reply is already waiting. */
const detail = computed(() => {
	const strip = data.value;
	if (!strip) return null;
	if (strip.isReplied) return t('components.postbox.postboxCrossSurfaceStrip.replied');
	if (strip.assigneeName && strip.isDraftPending) {
		return t('components.postbox.postboxCrossSurfaceStrip.assignedWithDraft', {
			assignee: strip.assigneeName,
		});
	}
	if (strip.assigneeName) {
		return t('components.postbox.postboxCrossSurfaceStrip.assigned', {
			assignee: strip.assigneeName,
		});
	}
	if (strip.isDraftPending) return t('components.postbox.postboxCrossSurfaceStrip.draftPending');
	return t('components.postbox.postboxCrossSurfaceStrip.unassigned');
});
</script>

<template>
	<aside
		v-if="data"
		class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-border-subtle bg-bg-surface px-3 py-2 text-sm"
	>
		<Icon name="lucide:users" class="w-4 h-4 flex-shrink-0 text-text-tertiary" />
		<span class="text-text-secondary">{{
			t('components.postbox.postboxCrossSurfaceStrip.alsoInTeamInbox')
		}}</span>
		<span class="text-text-tertiary">{{ detail }}</span>
		<NuxtLink :to="link" class="ml-auto text-brand hover:underline">
			{{ t('components.postbox.postboxCrossSurfaceStrip.open') }}
		</NuxtLink>
	</aside>
</template>
