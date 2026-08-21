<script setup lang="ts">
/**
 * Desktop-only manager for the connected Owlat workspaces (Slack-style servers).
 *
 * Lists every connected instance and lets the user switch to, disconnect, or add
 * one. Reuses the same reactive state + actions as the titlebar workspace
 * switcher (useDesktopWorkspaces). The parent Workspace settings page gates this
 * to the desktop runtime, so this component assumes it is only ever rendered
 * there.
 */
import type { WorkspaceConfig } from '~/lib/desktop/workspaceTypes';

const { t } = useI18n();
const { workspaces, activeId, switchTo, removeWorkspace } = useDesktopWorkspaces();

const pendingRemove = ref<WorkspaceConfig | null>(null);
const isRemoving = ref(false);

function askRemove(ws: WorkspaceConfig): void {
	pendingRemove.value = ws;
}

async function confirmRemove(): Promise<void> {
	const ws = pendingRemove.value;
	if (!ws) return;
	isRemoving.value = true;
	try {
		await removeWorkspace(ws.id);
	} finally {
		isRemoving.value = false;
		pendingRemove.value = null;
	}
}

function addWorkspace(): void {
	void navigateTo('/desktop/welcome');
}
</script>

<template>
	<div class="rounded-lg border border-border-subtle divide-y divide-border-subtle">
		<div
			v-if="!workspaces.length"
			class="flex flex-col items-start gap-3 p-4"
		>
			<p class="text-sm text-text-secondary">
				{{ t('components.settings.connectedWorkspaces.empty') }}
			</p>
			<UiButton variant="primary" size="sm" @click="addWorkspace">
				<template #iconLeft>
					<Icon name="lucide:plus" class="w-4 h-4" />
				</template>
				{{ t('components.settings.connectedWorkspaces.add') }}
			</UiButton>
		</div>

		<template v-else>
			<div
				v-for="ws in workspaces"
				:key="ws.id"
				class="flex items-center gap-3 p-4"
			>
				<!-- palette-ok: hairline on the workspace's own accent colour, as in
				     WorkspaceMenu — it edges an arbitrary user value, not a token surface. -->
				<span
					class="h-2.5 w-2.5 rounded-full shrink-0 ring-1 ring-inset ring-black/10"
					:style="{ backgroundColor: ws.accentColor }"
				/>
				<div class="min-w-0 flex-1">
					<span
						class="block text-sm truncate"
						:class="ws.id === activeId ? 'font-semibold text-text-primary' : 'text-text-primary'"
					>
						{{ ws.label }}
					</span>
					<span class="block text-xs text-text-tertiary truncate">{{ ws.siteUrl }}</span>
				</div>

				<UiBadge v-if="ws.id === activeId" variant="success">{{ t('common.active') }}</UiBadge>
				<UiButton v-else variant="secondary" size="sm" @click="switchTo(ws.id)">
					{{ t('components.settings.connectedWorkspaces.switch') }}
				</UiButton>

				<UiButton variant="danger-ghost" size="sm" @click="askRemove(ws)">
					{{ t('components.settings.connectedWorkspaces.disconnect') }}
				</UiButton>
			</div>

			<div class="p-4">
				<UiButton variant="primary" size="sm" @click="addWorkspace">
					<template #iconLeft>
						<Icon name="lucide:plus" class="w-4 h-4" />
					</template>
					{{ t('components.settings.connectedWorkspaces.add') }}
				</UiButton>
			</div>
		</template>

		<UiConfirmationDialog
			:open="!!pendingRemove"
			variant="danger"
			:title="t('components.settings.connectedWorkspaces.confirmTitle')"
			:description="
				pendingRemove
					? t('components.settings.connectedWorkspaces.confirmDescription', { label: pendingRemove.label })
					: ''
			"
			:confirm-text="t('components.settings.connectedWorkspaces.disconnect')"
			:is-loading="isRemoving"
			@update:open="(v: boolean) => !v && (pendingRemove = null)"
			@confirm="confirmRemove"
			@cancel="pendingRemove = null"
		/>
	</div>
</template>
