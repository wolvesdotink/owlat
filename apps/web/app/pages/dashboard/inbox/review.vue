<script setup lang="ts">
import ReviewBrowseList from '~/components/agent-tasks/ReviewBrowseList.vue';
import ReviewFocusFlow from '~/components/agent-tasks/ReviewFocusFlow.vue';

useHead({ title: 'Review Queue — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresFeature: 'inbox',
});

// "Focus" runs the same one-task-at-a-time card-stack flow (useTaskFlow) over
// these review items; ReviewBrowseList stays as the keyboard-first browse
// alternative. Separate flow from the personal Reply Queue — different data
// source, never interleaved. The two views are mutually exclusive: the browse
// list is a doing-adjacent surface, the Focus flow is the self-contained
// one-task surface (its own chrome + "Back to list" exit).
const focusMode = ref(false);
</script>

<template>
	<div class="p-6 lg:p-8">
		<ReviewFocusFlow v-if="focusMode" @exit="focusMode = false" />
		<ReviewBrowseList v-else @focus="focusMode = true" />
	</div>
</template>
