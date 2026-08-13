<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	deserializeVersionSnapshot,
	formatSnapshotSize,
	type HistoryState,
} from '@owlat/email-builder';

/**
 * Persisted version history for one email template — the durable sibling of the
 * editor's session-scoped undo stack. Snapshots are captured server-side on
 * save, publish and campaign send (`apps/api/convex/emailTemplates/versions.ts`).
 *
 * Restore does NOT write: it hands the parsed snapshot back to the editor,
 * which loads it as working state, so it lands in the undo stack like any other
 * edit and only reaches the server on the next save.
 */
const props = defineProps<{
	templateId: Id<'emailTemplates'>;
	hasUnsavedChanges: boolean;
}>();

const emit = defineEmits<{ restore: [state: HistoryState] }>();

const isOpen = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

const { emailTheme } = useEmailTheme();
const { renderBlocksToHtml } = useEmailHtmlRendering();
const { showToast } = useToast();
const convex = useConvex();

// Only subscribe while the panel is open — history is a rarely-opened side
// surface and the editor page is already subscription-heavy.
const { data: versions, isLoading } = useConvexQuery(api.emailTemplates.versions.list, () =>
	isOpen.value ? { templateId: props.templateId } : ('skip' as const)
);

type VersionSummary = NonNullable<typeof versions.value>[number];

const TRIGGER_LABELS: Record<VersionSummary['trigger'], string> = {
	save: 'Saved',
	publish: 'Published',
	send: 'Sent',
};

const TRIGGER_ICONS: Record<VersionSummary['trigger'], string> = {
	save: 'lucide:save',
	publish: 'lucide:globe',
	send: 'lucide:send',
};

// ── Preview ────────────────────────────────────────────────────────────────

const previewVersion = ref<VersionSummary | null>(null);
const previewHtml = ref('');
const isPreviewLoading = ref(false);
const isPreviewOpen = computed({
	get: () => previewVersion.value !== null,
	set: (open: boolean) => {
		if (!open) previewVersion.value = null;
	},
});

async function loadSnapshot(versionId: Id<'emailTemplateVersions'>) {
	if (!convex) throw new Error('Convex client is not available');
	return await convex.query(api.emailTemplates.versions.get, { versionId });
}

async function openPreview(version: VersionSummary) {
	previewVersion.value = version;
	previewHtml.value = '';
	isPreviewLoading.value = true;
	try {
		const snapshot = await loadSnapshot(version._id);
		const state = deserializeVersionSnapshot(snapshot);
		previewHtml.value = renderBlocksToHtml(state.blocks, {
			theme: emailTheme.value,
			variableType: 'personalization',
		});
	} catch {
		previewVersion.value = null;
		showToast("Couldn't load that version", 'error');
	} finally {
		isPreviewLoading.value = false;
	}
}

// ── Restore ────────────────────────────────────────────────────────────────

const pendingRestore = ref<VersionSummary | null>(null);
const isRestoring = ref(false);

function requestRestore(version: VersionSummary) {
	// Restoring is undoable, but it still replaces whatever is on the canvas —
	// worth one confirmation when that canvas holds unsaved work.
	if (props.hasUnsavedChanges) {
		// The preview modal renders above the builder at z 10001; the confirmation
		// dialog only reaches the default modal layer, so it would open invisibly
		// behind an open preview. Close the preview first — cancelling still
		// leaves the history panel open behind it.
		previewVersion.value = null;
		pendingRestore.value = version;
		return;
	}
	void applyRestore(version);
}

async function applyRestore(version: VersionSummary) {
	isRestoring.value = true;
	try {
		const snapshot = await loadSnapshot(version._id);
		emit('restore', deserializeVersionSnapshot(snapshot));
		isOpen.value = false;
		previewVersion.value = null;
		showToast('Version loaded into the editor — save to keep it, or undo to go back');
	} catch {
		showToast("Couldn't restore that version", 'error');
	} finally {
		isRestoring.value = false;
		pendingRestore.value = null;
	}
}

// ── Panel chrome (mirrors ShareLinksPopover) ───────────────────────────────

const panelRightPx = computed(() => {
	if (!triggerRef.value) return '0';
	return `${document.documentElement.clientWidth - triggerRef.value.getBoundingClientRect().right}px`;
});

useClickOutside([panelRef, triggerRef], () => {
	// The preview modal teleports outside the panel; closing the panel behind it
	// would strand the modal's restore button.
	if (isOpen.value && previewVersion.value === null && pendingRestore.value === null) {
		isOpen.value = false;
	}
});

const handleEscape = (event: KeyboardEvent) => {
	// Escape belongs to whichever overlay sits on top of the panel.
	if (event.key === 'Escape' && previewVersion.value === null && pendingRestore.value === null) {
		isOpen.value = false;
	}
};
watch(isOpen, (open) => {
	if (open) document.addEventListener('keydown', handleEscape);
	else document.removeEventListener('keydown', handleEscape);
});
onUnmounted(() => document.removeEventListener('keydown', handleEscape));
</script>

<template>
	<div class="relative inline-block">
		<div ref="triggerRef">
			<UiButton variant="outline" size="sm" title="Version history" @click.stop="isOpen = !isOpen">
				<template #iconLeft>
					<Icon name="lucide:history" class="w-4 h-4" />
				</template>
				History
			</UiButton>
		</div>

		<Teleport to="body">
			<Transition
				enter-active-class="duration-(--motion-moderate) ease-spring"
				enter-from-class="opacity-0 scale-95"
				enter-to-class="opacity-100 scale-100"
				leave-active-class="duration-(--motion-moderate-exit) ease-exit"
				leave-from-class="opacity-100 scale-100"
				leave-to-class="opacity-0 scale-95"
			>
				<div
					v-if="isOpen"
					ref="panelRef"
					class="fixed z-50 w-96 bg-bg-elevated border border-border-subtle rounded-lg shadow-lg"
					:style="{
						top: triggerRef ? `${triggerRef.getBoundingClientRect().bottom + 8}px` : '0',
						right: panelRightPx,
					}"
				>
					<div class="p-3 border-b border-border-subtle">
						<h3 class="text-sm font-medium text-text-primary">Version history</h3>
						<p class="text-xs text-text-tertiary mt-0.5">
							Snapshots taken on every save, publish and send
						</p>
					</div>

					<div class="max-h-96 overflow-y-auto">
						<div v-if="isLoading" class="px-3 py-6 flex justify-center">
							<UiSpinner />
						</div>

						<div
							v-else-if="!versions?.length"
							class="px-3 py-4 text-center text-xs text-text-tertiary"
						>
							No versions yet. Saving this email records one.
						</div>

						<template v-else>
							<div
								v-for="version in versions"
								:key="version._id"
								class="px-3 py-2 border-b border-border-subtle last:border-b-0 flex items-center justify-between gap-2 hover:bg-bg-surface transition-colors"
							>
								<div class="min-w-0">
									<div class="flex items-center gap-1.5">
										<Icon
											:name="TRIGGER_ICONS[version.trigger]"
											class="w-3.5 h-3.5 text-text-tertiary shrink-0"
										/>
										<span class="text-xs font-medium text-text-primary">
											{{ TRIGGER_LABELS[version.trigger] }}
										</span>
										<span
											class="text-xs text-text-tertiary"
											:title="new Date(version.createdAt).toLocaleString()"
										>
											{{ formatRelativeTime(version.createdAt) }}
										</span>
									</div>
									<p class="text-xs text-text-tertiary truncate mt-0.5">
										{{ version.subject || version.name }} &middot;
										{{ formatSnapshotSize(version.contentBytes) }}
									</p>
								</div>

								<div class="flex items-center gap-1 shrink-0">
									<button
										class="p-1 rounded hover:bg-bg-surface text-text-secondary hover:text-text-primary transition-colors"
										title="Preview this version"
										@click="openPreview(version)"
									>
										<Icon name="lucide:eye" class="w-3.5 h-3.5" />
									</button>
									<button
										class="p-1 rounded hover:bg-bg-surface text-text-secondary hover:text-text-primary transition-colors"
										title="Restore this version into the editor"
										:disabled="isRestoring"
										@click="requestRestore(version)"
									>
										<Icon name="lucide:rotate-ccw" class="w-3.5 h-3.5" />
									</button>
								</div>
							</div>
						</template>
					</div>
				</div>
			</Transition>
		</Teleport>

		<!-- Snapshot preview -->
		<UiModal v-model:open="isPreviewOpen" size="3xl" :z-index="10001">
			<div class="flex items-center gap-3 mb-4">
				<UiIconBox icon="lucide:history" size="sm" variant="brand" rounded="lg" />
				<div class="min-w-0">
					<h2 class="text-lg font-semibold text-text-primary truncate">
						{{ previewVersion?.name }}
					</h2>
					<p class="text-sm text-text-secondary truncate">
						{{ previewVersion ? TRIGGER_LABELS[previewVersion.trigger] : '' }}
						{{ previewVersion ? formatRelativeTime(previewVersion.createdAt) : '' }}
						&middot; {{ previewVersion?.subject }}
					</p>
				</div>
			</div>

			<div
				class="h-[60vh] rounded-lg border border-border-subtle overflow-hidden bg-bg-deep flex items-center justify-center"
			>
				<UiSpinner v-if="isPreviewLoading" />
				<!-- palette-ok-start: the paper stays literally white in both app themes —
				     the snapshot's own HTML carries its (light) colors, so a theme token
				     here would only show as a mismatched flash behind the frame. -->
				<iframe
					v-else
					:srcdoc="previewHtml"
					sandbox=""
					title="Version preview"
					class="w-full h-full bg-white"
				/>
				<!-- palette-ok-end -->
			</div>

			<UiModalFooter>
				<UiButton variant="secondary" @click="isPreviewOpen = false">Close</UiButton>
				<UiButton
					:loading="isRestoring"
					:disabled="!previewVersion"
					@click="previewVersion && requestRestore(previewVersion)"
				>
					<template #iconLeft>
						<Icon name="lucide:rotate-ccw" class="w-4 h-4" />
					</template>
					Restore this version
				</UiButton>
			</UiModalFooter>
		</UiModal>

		<UiConfirmationDialog
			:open="pendingRestore !== null"
			title="Replace your unsaved changes?"
			description="This email has edits you haven't saved. Restoring loads the older version onto the canvas — you can undo it, but the restore itself is not saved until you save."
			confirm-text="Restore version"
			variant="warning"
			:is-loading="isRestoring"
			@update:open="(open: boolean) => { if (!open) pendingRestore = null; }"
			@confirm="pendingRestore && applyRestore(pendingRestore)"
			@cancel="pendingRestore = null"
		/>
	</div>
</template>
