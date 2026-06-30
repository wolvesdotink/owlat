<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

defineProps<{ mailboxId: Id<'mailboxes'> }>();

const stack = usePostboxComposerStack();

function handleClick(mailboxId: Id<'mailboxes'>) {
	stack.open({ mailboxId });
}
</script>

<template>
	<button
		type="button"
		class="btn btn-primary w-full"
		@click="handleClick(mailboxId)"
	>
		<Icon name="lucide:pen-line" class="w-4 h-4 mr-1.5" />
		Compose
	</button>
</template>
