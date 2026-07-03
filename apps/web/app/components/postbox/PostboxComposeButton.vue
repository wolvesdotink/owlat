<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

defineProps<{ mailboxId: Id<'mailboxes'>; collapsed?: boolean }>();

const stack = usePostboxComposerStack();

function handleClick(mailboxId: Id<'mailboxes'>) {
	stack.open({ mailboxId });
}
</script>

<template>
	<button
		type="button"
		class="btn btn-primary"
		:class="collapsed ? 'w-9 h-9 !px-0 justify-center' : 'w-full'"
		:title="collapsed ? 'Compose' : undefined"
		:aria-label="collapsed ? 'Compose' : undefined"
		@click="handleClick(mailboxId)"
	>
		<Icon name="lucide:pen-line" class="w-4 h-4" :class="{ 'mr-1.5': !collapsed }" />
		<span v-if="!collapsed">Compose</span>
	</button>
</template>
