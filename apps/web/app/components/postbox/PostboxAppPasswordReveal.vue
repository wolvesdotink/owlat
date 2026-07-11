<script setup lang="ts">
const props = defineProps<{
	open: boolean;
	password: string | null;
	label: string | null;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
}>();

const { copy, copiedKey } = useCopyToClipboard();
const copied = computed(() => copiedKey.value === 'app-password');

async function copyPassword() {
	if (!props.password) return;
	await copy(props.password, 'app-password');
}

function close() {
	emit('update:open', false);
}
</script>

<template>
	<UiModal :open="open && !!password" size="md" @update:open="emit('update:open', $event)">
		<div v-if="password">
			<header class="flex items-start gap-3 mb-4">
				<div
					class="w-9 h-9 rounded-full bg-warning/10 text-warning flex items-center justify-center flex-shrink-0"
				>
					<Icon name="lucide:key-round" class="w-5 h-5" />
				</div>
				<div class="flex-1">
					<h2 class="text-lg font-semibold">Save this password now</h2>
					<p class="text-sm text-text-secondary mt-0.5">
						Owlat does not store the cleartext — once you close this dialog it is gone for good.
						Paste it into <strong>{{ label || 'your client' }}</strong>
						and revoke this entry to rotate later.
					</p>
				</div>
			</header>

			<div
				class="p-3 rounded border border-border-subtle bg-bg-base font-mono tracking-wider text-lg text-center select-all"
			>
				{{ password }}
			</div>

			<div class="flex items-center justify-between mt-4">
				<button type="button" class="btn btn-ghost" @click="copyPassword">
					<Icon :name="copied ? 'lucide:check' : 'lucide:copy'" class="w-4 h-4 mr-1.5" />
					{{ copied ? 'Copied' : 'Copy' }}
				</button>
				<button type="button" class="btn btn-primary" @click="close">I've saved it</button>
			</div>
		</div>
	</UiModal>
</template>
