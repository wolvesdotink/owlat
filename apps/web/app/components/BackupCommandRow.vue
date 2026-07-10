<script setup lang="ts">
// One copy-to-clipboard command row for the Backups panel. The panel records
// what you ran on your server; these rows are the source of truth (the exact
// command), so every section renders through this one shape.
const props = defineProps<{ command: string }>();

const { showToast } = useToast();
const { copy, isCopied } = useCopyToClipboard();

async function copyCommand() {
	const ok = await copy(props.command);
	showToast(
		ok ? 'Command copied' : 'Could not copy — select and copy manually',
		ok ? 'success' : 'error'
	);
}
</script>

<template>
	<div
		class="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-bg-surface px-3 py-2"
	>
		<code class="truncate font-mono text-sm text-text-primary">{{ command }}</code>
		<button
			type="button"
			class="shrink-0 text-sm text-text-tertiary hover:text-brand transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded"
			@click="copyCommand"
		>
			{{ isCopied(command) ? 'Copied' : 'Copy' }}
		</button>
	</div>
</template>
