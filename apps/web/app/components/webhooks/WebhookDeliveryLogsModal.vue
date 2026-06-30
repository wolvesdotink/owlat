<script setup lang="ts">
// --- Created Webhook Secret Modal ---
interface CreatedWebhookProps {
	showCreatedWebhook: boolean;
	createdWebhook: { name: string; url: string; secret: string } | null;
	copiedSecret: boolean;
}

// --- Regenerate Secret Modal ---
interface RegenerateProps {
	isRegenerateModalOpen: boolean;
	webhookToRegenerate: { id: string; name: string } | null;
	isRegenerating: boolean;
	regeneratedSecret: string | null;
	copiedRegeneratedSecret: boolean;
}

// --- Delete Webhook Modal ---
interface DeleteProps {
	isDeleteModalOpen: boolean;
	webhookToDelete: { id: string; name: string } | null;
	isDeleting: boolean;
}

type Props = CreatedWebhookProps & RegenerateProps & DeleteProps;

defineProps<Props>();

const emit = defineEmits<{
	closeCreatedWebhook: [];
	copySecret: [];
	closeRegenerate: [];
	regenerate: [];
	copyRegeneratedSecret: [];
	closeDelete: [];
	confirmDelete: [];
}>();
</script>

<template>
	<!-- Created Webhook Secret Modal -->
	<UiModal
		:open="showCreatedWebhook && !!createdWebhook"
		size="lg"
		:closable="false"
		:persistent="true"
	>
		<template v-if="createdWebhook">
			<!-- Header -->
			<div class="flex items-center gap-3 mb-6">
				<div class="p-2 rounded-lg bg-success/10">
					<Icon name="lucide:webhook" class="w-5 h-5 text-success" />
				</div>
				<h2 class="text-lg font-semibold text-text-primary">Webhook Created</h2>
			</div>

			<!-- Content -->
			<div class="mb-4 p-4 rounded-lg bg-warning/10 border border-warning/20">
				<div class="flex items-start gap-3">
					<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
					<div>
						<p class="text-sm font-medium text-warning">Copy your webhook secret now</p>
						<p class="text-sm text-warning/80 mt-1">
							Use this secret to verify webhook signatures. Store it securely - you won't be
							able to see it again.
						</p>
					</div>
				</div>
			</div>

			<div class="mb-4">
				<label class="label">Name</label>
				<p class="text-text-primary font-medium">{{ createdWebhook.name }}</p>
			</div>

			<div class="mb-4">
				<label class="label">Endpoint URL</label>
				<p class="text-text-secondary text-sm break-all">{{ createdWebhook.url }}</p>
			</div>

			<div>
				<label class="label">Signing Secret</label>
				<div class="flex items-center gap-2">
					<code
						class="flex-1 px-4 py-3 rounded-lg bg-bg-deep text-text-primary text-sm font-mono break-all border border-border-subtle"
					>
						{{ createdWebhook.secret }}
					</code>
					<button class="btn btn-secondary shrink-0 gap-2" @click="emit('copySecret')">
						<Icon v-if="copiedSecret" name="lucide:check" class="w-4 h-4 text-success" />
						<Icon v-else name="lucide:copy" class="w-4 h-4" />
						{{ copiedSecret ? 'Copied!' : 'Copy' }}
					</button>
				</div>
			</div>
		</template>

		<template #footer>
			<button class="btn btn-primary" @click="emit('closeCreatedWebhook')">Done</button>
		</template>
	</UiModal>

	<!-- Regenerate Secret Modal -->
	<UiModal
		:open="isRegenerateModalOpen"
		:title="regeneratedSecret ? 'New Secret Generated' : 'Regenerate Secret'"
		size="md"
		:closable="!isRegenerating"
		:persistent="isRegenerating || !!regeneratedSecret"
		@update:open="(v) => { if (!v) emit('closeRegenerate'); }"
	>
		<!-- Content - Before Regeneration -->
		<div v-if="!regeneratedSecret" class="flex items-start gap-4">
			<div class="p-3 rounded-full bg-warning/10 shrink-0">
				<Icon name="lucide:refresh-cw" class="w-6 h-6 text-warning" />
			</div>
			<div>
				<p class="text-text-primary">
					Regenerate secret for
					<span class="font-semibold">"{{ webhookToRegenerate?.name }}"</span>?
				</p>
				<p class="text-sm text-text-secondary mt-2">
					The current secret will be invalidated immediately. You'll need to update your
					webhook endpoint with the new secret.
				</p>
			</div>
		</div>

		<!-- Content - After Regeneration -->
		<div v-else>
			<div class="mb-4 p-4 rounded-lg bg-warning/10 border border-warning/20">
				<div class="flex items-start gap-3">
					<Icon name="lucide:alert-circle" class="w-5 h-5 text-warning shrink-0 mt-0.5" />
					<div>
						<p class="text-sm font-medium text-warning">Copy your new secret now</p>
						<p class="text-sm text-warning/80 mt-1">
							Store it securely - you won't be able to see it again.
						</p>
					</div>
				</div>
			</div>

			<div>
				<label class="label">New Signing Secret</label>
				<div class="flex items-center gap-2">
					<code
						class="flex-1 px-4 py-3 rounded-lg bg-bg-deep text-text-primary text-sm font-mono break-all border border-border-subtle"
					>
						{{ regeneratedSecret }}
					</code>
					<button
						class="btn btn-secondary shrink-0 gap-2"
						@click="emit('copyRegeneratedSecret')"
					>
						<Icon v-if="copiedRegeneratedSecret" name="lucide:check" class="w-4 h-4 text-success" />
						<Icon v-else name="lucide:copy" class="w-4 h-4" />
						{{ copiedRegeneratedSecret ? 'Copied!' : 'Copy' }}
					</button>
				</div>
			</div>
		</div>

		<template #footer>
			<button
				v-if="!regeneratedSecret"
				class="btn btn-secondary"
				:disabled="isRegenerating"
				@click="emit('closeRegenerate')"
			>
				Cancel
			</button>
			<button
				v-if="!regeneratedSecret"
				class="btn bg-warning text-white hover:bg-warning/90 gap-2"
				:disabled="isRegenerating"
				@click="emit('regenerate')"
			>
				<Icon v-if="isRegenerating" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
				{{ isRegenerating ? 'Regenerating...' : 'Regenerate' }}
			</button>
			<button v-else class="btn btn-primary" @click="emit('closeRegenerate')">Done</button>
		</template>
	</UiModal>

	<!-- Delete Webhook Modal -->
	<UiModal
		:open="isDeleteModalOpen"
		title="Delete Webhook"
		size="md"
		:closable="!isDeleting"
		:persistent="isDeleting"
		@update:open="(v) => { if (!v) emit('closeDelete'); }"
	>
		<div class="flex items-start gap-4">
			<div class="p-3 rounded-full bg-error/10 shrink-0">
				<Icon name="lucide:trash-2" class="w-6 h-6 text-error" />
			</div>
			<div>
				<p class="text-text-primary">
					Are you sure you want to delete
					<span class="font-semibold">"{{ webhookToDelete?.name }}"</span>?
				</p>
				<p class="text-sm text-text-secondary mt-2">
					This action cannot be undone. The webhook will stop receiving notifications
					immediately.
				</p>
			</div>
		</div>

		<template #footer>
			<button class="btn btn-secondary" :disabled="isDeleting" @click="emit('closeDelete')">
				Cancel
			</button>
			<button
				class="btn bg-error text-white hover:bg-error/90 gap-2"
				:disabled="isDeleting"
				@click="emit('confirmDelete')"
			>
				<Icon v-if="isDeleting" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
				{{ isDeleting ? 'Deleting...' : 'Delete Webhook' }}
			</button>
		</template>
	</UiModal>
</template>
