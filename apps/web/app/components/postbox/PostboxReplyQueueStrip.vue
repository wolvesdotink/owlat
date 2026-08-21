<script setup lang="ts">
/**
 * Compact "waiting on your reply" strip at the top of the inbox list —
 * non-empty queue only, dismissible for the session (the dismissed flag is
 * owned by the layout). Extracted from PostboxLayout to keep it under the
 * file-size ratchet.
 */
defineProps<{ count: number }>();

const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
	<div class="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-brand/5 text-sm">
		<Icon name="lucide:reply" class="w-4 h-4 text-brand flex-shrink-0" />
		<span class="flex-1 truncate text-text-secondary">
			{{ count }} {{ count === 1 ? 'email is' : 'emails are' }} waiting on your reply
		</span>
		<NuxtLink to="/dashboard/postbox/reply-queue" class="text-brand hover:underline flex-shrink-0">
			Open queue
		</NuxtLink>
		<button
			type="button"
			class="p-0.5 rounded text-text-tertiary hover:text-text-primary flex-shrink-0"
			title="Dismiss for this session"
			aria-label="Dismiss reply queue reminder"
			@click="emit('dismiss')"
		>
			<Icon name="lucide:x" class="w-3.5 h-3.5" />
		</button>
	</div>
</template>
