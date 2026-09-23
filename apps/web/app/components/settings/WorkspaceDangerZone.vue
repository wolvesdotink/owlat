<script setup lang="ts">
import { api } from '@owlat/api';

/**
 * Workspace → General → Danger zone: deleting the whole workspace.
 *
 * It used to sit at the bottom of the Team page, one scroll below changing a
 * member's role. Owner only; the modal arms its button only once DELETE has
 * been typed. On success the backend deletion walker is scheduled and the owner
 * is signed out, because the tenant they are signed in to is going away.
 */
const { t } = useI18n();
const { canDeleteOrganization } = usePermissions();
const { organization } = useOrganization();
const { signOut } = useAuth();
const { showToast } = useToast();

const showDeleteModal = ref(false);
const isDeleting = ref(false);
const { run: removeOrganization } = useBackendOperation(api.workspaces.settings.remove, {
	label: () => t('dashboard.admin.team.operations.deleteWorkspace'),
});

async function handleDelete() {
	isDeleting.value = true;
	const result = await removeOrganization({});
	if (!result.ok) {
		isDeleting.value = false;
		return;
	}
	showToast(t('dashboard.admin.team.toasts.workspaceDeletionStarted'));
	showDeleteModal.value = false;
	try {
		await signOut();
	} catch {
		isDeleting.value = false;
	}
}
</script>

<template>
	<section
		v-if="canDeleteOrganization"
		id="danger-zone"
		aria-labelledby="danger-zone-heading"
		class="scroll-mt-6"
	>
		<UiCard padding="none" overflow="hidden" class="border-error/20">
			<template #header>
				<div class="flex items-center gap-3">
					<UiIconBox icon="lucide:trash-2" size="sm" variant="error" rounded="lg" />
					<div>
						<h2 id="danger-zone-heading" class="text-lg font-semibold text-error">
							{{ t('dashboard.admin.team.dangerZone.heading') }}
						</h2>
						<p class="text-sm text-error/80">
							{{ t('dashboard.admin.team.dangerZone.subtitle') }}
						</p>
					</div>
				</div>
			</template>

			<div class="p-6">
				<p class="mb-4 text-sm text-text-secondary">
					{{ t('dashboard.admin.team.dangerZone.body') }}
				</p>
				<UiButton variant="danger" @click="showDeleteModal = true">
					<template #iconLeft>
						<Icon name="lucide:trash-2" class="h-4 w-4" />
					</template>
					{{ t('dashboard.admin.team.dangerZone.title') }}
				</UiButton>
			</div>
		</UiCard>

		<SettingsTeamDeleteWorkspaceModal
			:open="showDeleteModal"
			:workspace-name="organization?.name"
			:busy="isDeleting"
			@close="showDeleteModal = false"
			@confirm="handleDelete"
		/>
	</section>
</template>
