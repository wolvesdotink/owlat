<script setup lang="ts">
/**
 * Desktop-only manager for the connected Owlat workspaces (Slack-style servers).
 *
 * Lists every connected instance and lets the user switch to, disconnect, or add
 * one. Reuses the same reactive state + actions as the titlebar workspace
 * switcher (useDesktopWorkspaces). Renders a muted note on web, where workspace
 * switching does not apply.
 */
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';
import type { WorkspaceConfig } from '~/lib/desktop/workspaceTypes';

const isDesktop = computed(() => isDesktopRuntime());

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
			v-if="!isDesktop"
			class="p-4 text-sm text-text-secondary"
		>
			Workspace switching is available in the desktop app.
		</div>

		<template v-else>
			<div
				v-if="!workspaces.length"
				class="flex flex-col items-start gap-3 p-4"
			>
				<p class="text-sm text-text-secondary">No workspaces connected yet.</p>
				<UiButton variant="primary" size="sm" @click="addWorkspace">
					<template #iconLeft>
						<Icon name="lucide:plus" class="w-4 h-4" />
					</template>
					Add workspace
				</UiButton>
			</div>

			<template v-else>
				<div
					v-for="ws in workspaces"
					:key="ws.id"
					class="flex items-center gap-3 p-4"
				>
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

					<UiBadge v-if="ws.id === activeId" variant="success">Active</UiBadge>
					<UiButton v-else variant="secondary" size="sm" @click="switchTo(ws.id)">
						Switch
					</UiButton>

					<UiButton variant="danger-ghost" size="sm" @click="askRemove(ws)">
						Disconnect
					</UiButton>
				</div>

				<div class="p-4">
					<UiButton variant="primary" size="sm" @click="addWorkspace">
						<template #iconLeft>
							<Icon name="lucide:plus" class="w-4 h-4" />
						</template>
						Add workspace
					</UiButton>
				</div>
			</template>
		</template>

		<UiConfirmationDialog
			:open="!!pendingRemove"
			variant="danger"
			title="Disconnect workspace?"
			:description="
				pendingRemove
					? `Disconnect “${pendingRemove.label}”? You'll need to reconnect to use this workspace again.`
					: ''
			"
			confirm-text="Disconnect"
			:is-loading="isRemoving"
			@update:open="(v: boolean) => !v && (pendingRemove = null)"
			@confirm="confirmRemove"
			@cancel="pendingRemove = null"
		/>
	</div>
</template>
