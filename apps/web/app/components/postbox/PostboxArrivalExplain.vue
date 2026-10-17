<script setup lang="ts">
/**
 * Read on arrival §4 inside the Postbox: the "Why here?" popover, the Fix
 * dialog and the learned-digest notice. The state comes from
 * `usePostboxArrivalExplainHost`, which PostboxLayout calls (it also answers
 * the reader's and the Priority view's "Why here?" links).
 */
import type { PostboxWhyHereTarget } from '~/composables/postbox/usePostboxWhyHere';
import {
	usePostboxArrivalExplainState,
	type PostboxFixTarget,
} from '~/composables/postbox/usePostboxArrivalExplain';
import { usePostboxLearnedNotices } from '~/composables/postbox/usePostboxLearnedNotices';

const { why, fix, mailboxId } = usePostboxArrivalExplainState();
usePostboxLearnedNotices(mailboxId);

function setWhy(target: PostboxWhyHereTarget | null) {
	why.value = target;
}
function setFix(target: PostboxFixTarget | null) {
	fix.value = target;
}
</script>

<template>
	<PostboxWhyHerePopover :target="why" @update:target="setWhy" @fix="setFix" />
	<PostboxFixDialog :target="fix" @close="setFix(null)" />
</template>
