<script setup lang="ts">
import { api } from '@owlat/api';
import {
	MAX_WORKSPACE_LOGO_BYTES,
	WORKSPACE_LOGO_MIME_TYPES,
	workspaceLogoFileProblem,
	type WorkspaceLogoVariant,
} from '@owlat/shared/workspaceLogo';
import { uploadFileToStorage } from '~/utils/storageUpload';

/**
 * The workspace logo (Workspace → General, #810): the picture the sign-in,
 * invitation, unsubscribe and preferences pages show instead of the Owlat
 * mark.
 *
 * Two slots. The main logo is required for anything to show; the dark-mode
 * version is optional, because most logos are drawn for white and the public
 * pages put those on a light plate in dark mode rather than let them vanish.
 * The dark slot waits for the main one: a dark logo alone is never shown.
 *
 * Saves on its own, like the neighbouring cards: picking a file uploads and
 * applies it, and Remove takes it off every page at once.
 */

const { t } = useI18n();
const { canManageSettings } = usePermissions();
const { showToast } = useToast();

const { data: logo, isLoading } = useConvexQuery(api.workspaces.branding.get, {});

const sizeKb = MAX_WORKSPACE_LOGO_BYTES / 1024;
const accept = WORKSPACE_LOGO_MIME_TYPES.join(',');

const { run: generateUploadUrl } = useBackendOperation(api.storage.generateUploadUrl, {
	label: () => t('components.settings.workspaceLogoCard.uploadUrlOperation'),
});
const { run: setLogo } = useBackendOperation(api.workspaces.branding.setLogo, {
	label: () => t('components.settings.workspaceLogoCard.setOperation'),
});
const { run: removeLogo } = useBackendOperation(api.workspaces.branding.removeLogo, {
	label: () => t('components.settings.workspaceLogoCard.removeOperation'),
});

const busy = reactive<Record<WorkspaceLogoVariant, boolean>>({ light: false, dark: false });
const inputs = reactive<Record<WorkspaceLogoVariant, HTMLInputElement | null>>({
	light: null,
	dark: null,
});

const slots = computed(() => [
	{
		variant: 'light' as const,
		label: t('components.settings.workspaceLogoCard.lightLabel'),
		help: t('components.settings.workspaceLogoCard.lightHelp'),
		url: logo.value?.logoUrl ?? null,
		isLocked: false,
	},
	{
		variant: 'dark' as const,
		label: t('components.settings.workspaceLogoCard.darkLabel'),
		help: logo.value?.logoUrl
			? t('components.settings.workspaceLogoCard.darkHelp')
			: t('components.settings.workspaceLogoCard.darkNeedsLight'),
		url: logo.value?.logoDarkUrl ?? null,
		isLocked: !logo.value?.logoUrl,
	},
]);

function pick(variant: WorkspaceLogoVariant) {
	inputs[variant]?.click();
}

async function onFileChosen(variant: WorkspaceLogoVariant, event: Event) {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (!file || !canManageSettings.value) return;

	const problem = workspaceLogoFileProblem(file);
	if (problem) {
		showToast(
			t(`components.settings.workspaceLogoCard.errors.${problem}`, { size: sizeKb }),
			'error'
		);
		return;
	}

	busy[variant] = true;
	try {
		const upload = await uploadFileToStorage(file, () => generateUploadUrl({}));
		if (!upload.ok) {
			// A failed URL mint was already toasted by the operation.
			if (upload.reason !== 'no-url') {
				showToast(t('components.settings.workspaceLogoCard.errors.uploadFailed'), 'error');
			}
			return;
		}
		// The upload's Content-Type is the file type the server checks.
		const saved = await setLogo({ storageId: upload.storageId, variant });
		if (saved.ok) showToast(t('components.settings.workspaceLogoCard.savedToast'));
	} finally {
		busy[variant] = false;
	}
}

async function onRemove(variant: WorkspaceLogoVariant) {
	if (!canManageSettings.value) return;
	busy[variant] = true;
	try {
		const removed = await removeLogo({ variant });
		if (removed.ok) showToast(t('components.settings.workspaceLogoCard.removedToast'));
	} finally {
		busy[variant] = false;
	}
}
</script>

<template>
	<UiCard>
		<template #header>
			<div class="flex items-center gap-3">
				<UiIconBox icon="lucide:image" size="sm" variant="surface" rounded="lg" />
				<div class="min-w-0">
					<h2 class="text-lg font-medium text-text-primary">
						{{ t('components.settings.workspaceLogoCard.title') }}
					</h2>
					<p class="text-sm text-text-secondary">
						{{ t('components.settings.workspaceLogoCard.description', { size: sizeKb }) }}
					</p>
				</div>
			</div>
		</template>

		<div v-if="isLoading" class="flex justify-center py-4">
			<UiSpinner size="sm" />
		</div>

		<ul v-else class="divide-y divide-border-subtle">
			<li
				v-for="slot in slots"
				:key="slot.variant"
				class="flex flex-wrap items-center gap-4 py-4 first:pt-0 last:pb-0"
				:data-testid="`workspace-logo-slot-${slot.variant}`"
			>
				<!-- Each preview sits on the background it is for, whatever theme
				     the admin happens to be using: a dark-mode logo is judged on
				     dark, a regular one on light. The primary text colour is the
				     one token that is dark in the light theme and light in the
				     dark one, so it serves as the "other" background. -->
				<div
					class="flex h-16 w-40 shrink-0 items-center justify-center rounded-lg border border-border-subtle p-2"
					:class="
						slot.variant === 'dark'
							? 'bg-text-primary dark:bg-bg-base'
							: 'bg-bg-base dark:bg-text-primary'
					"
				>
					<img
						v-if="slot.url"
						:src="slot.url"
						alt=""
						class="max-h-12 max-w-full object-contain"
						:data-testid="`workspace-logo-preview-${slot.variant}`"
					/>
					<span v-else class="text-xs text-text-tertiary">
						{{ t('components.settings.workspaceLogoCard.empty') }}
					</span>
				</div>

				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium text-text-primary">{{ slot.label }}</p>
					<p class="mt-0.5 text-xs text-text-tertiary">{{ slot.help }}</p>
				</div>

				<div v-if="canManageSettings" class="flex items-center gap-2">
					<input
						:ref="(el) => (inputs[slot.variant] = el as HTMLInputElement | null)"
						type="file"
						class="sr-only"
						tabindex="-1"
						:accept="accept"
						:aria-label="slot.label"
						@change="onFileChosen(slot.variant, $event)"
					/>
					<UiButton
						variant="secondary"
						size="sm"
						:loading="busy[slot.variant]"
						:disabled="slot.isLocked"
						@click="pick(slot.variant)"
					>
						{{
							slot.url
								? t('components.settings.workspaceLogoCard.replace')
								: t('components.settings.workspaceLogoCard.upload')
						}}
					</UiButton>
					<UiButton
						v-if="slot.url"
						variant="ghost"
						size="sm"
						:disabled="busy[slot.variant]"
						@click="onRemove(slot.variant)"
					>
						{{ t('components.settings.workspaceLogoCard.remove') }}
					</UiButton>
				</div>
			</li>
		</ul>

		<p v-if="!canManageSettings" class="mt-4 text-xs text-text-tertiary">
			{{ t('components.settings.workspaceLogoCard.adminOnly') }}
		</p>
	</UiCard>
</template>
