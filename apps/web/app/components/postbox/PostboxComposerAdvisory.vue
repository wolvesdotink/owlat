<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

// The composer's advisory AI cluster: the "Coach my draft" self-check and the
// freeform whole-draft revise box. Both are advisory — they never send, and only
// mutate the body when the user clicks Apply on a shown revision. Extracted from
// PostboxComposer to keep that component under the file-size cap; behaviour is
// unchanged. The whole cluster stays hidden when AI is off or the draft is empty.
const bodyHtml = defineModel<string>('bodyHtml', { required: true });

defineProps<{
	aiEnabled: boolean;
	mailboxId: Id<'mailboxes'>;
	inReplyToMessageId?: Id<'mailMessages'>;
}>();

// Plain-text flatten of the live draft — the self-check critiques prose, not
// HTML tags. Client-only (the composer never SSRs); empty on the server so
// nothing renders until hydration.
const coachDraftText = computed(() => {
	const html = bodyHtml.value ?? '';
	if (!html || typeof window === 'undefined') return '';
	const doc = new DOMParser().parseFromString(html, 'text/html');
	return (doc.body.textContent ?? '').trim();
});

// Apply a freeform whole-draft revision (from AiReviseBox). The revise returns
// plain text; escape it and preserve line breaks so the rewritten draft replaces
// the body without injecting markup. Only runs on an explicit Apply.
function applyRevisedBody(text: string) {
	const escaped = text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
	bodyHtml.value = escaped
		.split(/\n/)
		.map((line) => (line.length ? line : '<br>'))
		.join('<br>');
}
</script>

<template>
	<!-- "Coach my draft": advisory self-check of the user's OWN wording for
	     high-stakes mail. Never rewrites; hidden when AI is off / draft short. -->
	<PostboxCoachPanel
		:draft-text="coachDraftText"
		:enabled="aiEnabled"
		:message-id="inReplyToMessageId"
	/>

	<!-- Freeform whole-draft revise ("make it half the length", "add that the
	     invoice is attached"), streamed progressively. Advisory: replaces the
	     body only on Apply; hidden when AI is off or the draft is empty. -->
	<AiReviseBox
		v-if="aiEnabled && coachDraftText"
		class="px-3 pb-2"
		surface="compose"
		:ai-enabled="aiEnabled"
		:current-draft="coachDraftText"
		:mailbox-id="mailboxId"
		@apply="applyRevisedBody"
	/>
</template>
