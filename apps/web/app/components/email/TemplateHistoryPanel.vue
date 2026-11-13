<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import {
	deserializeVersionSnapshot,
	formatSnapshotSize,
	type HistoryState,
} from '@owlat/email-builder';
import type { CompareSide } from './TemplateCompareModal.vue';
import {
	EyeIcon,
	GitCompareIcon,
	GitMergeIcon,
	GlobeIcon,
	HistoryIcon,
	PaperPlaneIcon,
	RotateLeftIcon,
	SaveIcon,
	type IconComponent,
} from '@coolicons/vue';

/**
 * Persisted version history for one email template — the durable sibling of the
 * editor's session-scoped undo stack. Snapshots are captured server-side on
 * save, publish and campaign send (`apps/api/convex/emailTemplates/versions.ts`).
 *
 * Restore does NOT write: it hands the parsed snapshot back to the editor,
 * which loads it as working state, so it lands in the undo stack like any other
 * edit and only reaches the server on the next save. Compare neither writes nor
 * restores: it shows a snapshot beside the editor's current state.
 */
const props = defineProps<{
	templateId: Id<'emailTemplates'>;
	hasUnsavedChanges: boolean;
	/** The editor saves by itself (a draft): a restore needs no Save. */
	autosaves?: boolean;
	/** The editor's state right now, unsaved edits included; enables "Compare". */
	readCurrent?: () => HistoryState;
}>();

const emit = defineEmits<{ restore: [state: HistoryState] }>();

const isOpen = ref(false);
const triggerRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);

const { t, locale } = useI18n();
const { emailTheme } = useEmailTheme();
const { renderBlocksToHtml } = useEmailHtmlRendering();
const { showToast } = useToast();
const convex = useConvex();

// Only subscribe while the panel is open — history is a rarely-opened side
// surface and the editor page is already subscription-heavy.
const {
	data: versions,
	isLoading,
	error: versionsError,
	refetch: refetchVersions,
} = useConvexQuery(api.emailTemplates.versions.list, () =>
	isOpen.value ? { templateId: props.templateId } : ('skip' as const)
);

const panelTitleId = useId();

/** One version's name in its row actions: "Restore Saved, 2 hours ago". */
const versionLabel = (version: VersionSummary) =>
	`${triggerLabel(version.trigger)}, ${formatRelativeTime(version.createdAt)}`;

type VersionSummary = NonNullable<typeof versions.value>[number];

// Message keys, not text: the record is built once at setup, so holding the
// translated string here would freeze the locale that happened to be active.
const TRIGGER_LABEL_KEYS: Record<VersionSummary['trigger'], string> = {
	save: 'components.email.templateHistoryPanel.triggers.save',
	publish: 'components.email.templateHistoryPanel.triggers.publish',
	send: 'components.email.templateHistoryPanel.triggers.send',
	conflict: 'components.email.templateHistoryPanel.triggers.conflict',
};

const triggerLabel = (trigger: VersionSummary['trigger']) => t(TRIGGER_LABEL_KEYS[trigger]);

/** Absolute snapshot timestamp, formatted for whichever locale is active. */
const absoluteTime = (createdAt: number) => new Date(createdAt).toLocaleString(locale.value);

const TRIGGER_ICONS: Record<VersionSummary['trigger'], IconComponent> = {
	save: SaveIcon,
	publish: GlobeIcon,
	send: PaperPlaneIcon,
	conflict: GitMergeIcon,
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

// A snapshot is immutable, but its row may go while it is on screen: the next
// autosave of the same person and window replaces it. What a preview or a
// restore confirmation loaded is what Restore applies, without asking again.
const loadedStates = new Map<Id<'emailTemplateVersions'>, Promise<HistoryState>>();

function loadState(versionId: Id<'emailTemplateVersions'>): Promise<HistoryState> {
	const cached = loadedStates.get(versionId);
	if (cached) return cached;
	const loading = (async () => {
		if (!convex) throw new Error('Convex client is not available');
		const snapshot = await convex.query(api.emailTemplates.versions.get, { versionId });
		return deserializeVersionSnapshot(snapshot);
	})();
	loadedStates.set(versionId, loading);
	loading.catch(() => loadedStates.delete(versionId));
	return loading;
}
watch(isOpen, (open) => {
	if (!open) loadedStates.clear();
});

async function openPreview(version: VersionSummary) {
	previewVersion.value = version;
	previewHtml.value = '';
	isPreviewLoading.value = true;
	try {
		const state = await loadState(version._id);
		previewHtml.value = renderBlocksToHtml(state.blocks, {
			theme: emailTheme.value,
			variableType: 'personalization',
		});
	} catch {
		previewVersion.value = null;
		showToast(t('components.email.templateHistoryPanel.loadFailed'), 'error');
	} finally {
		isPreviewLoading.value = false;
	}
}

// ── Compare with the editor ────────────────────────────────────────────────

const compareVersion = ref<VersionSummary | null>(null);
const compareBefore = shallowRef<CompareSide | null>(null);
const compareAfter = shallowRef<CompareSide | null>(null);
const isCompareLoading = ref(false);
// Bumped per comparison and on close: a snapshot that arrives for a comparison
// the user already left or replaced is dropped.
let compareRequest = 0;
const isCompareOpen = computed({
	get: () => compareVersion.value !== null,
	set: (open: boolean) => {
		if (open) return;
		compareVersion.value = null;
		compareRequest++;
	},
});

async function openCompare(version: VersionSummary) {
	if (!props.readCurrent) return;
	const request = ++compareRequest;
	// The canvas keeps moving while the dialog is open; the comparison is of the
	// moment it was asked for. One dialog at a time, so the preview closes.
	const current = props.readCurrent();
	previewVersion.value = null;
	compareVersion.value = version;
	compareBefore.value = null;
	compareAfter.value = {
		label: t('components.email.templateHistoryPanel.currentLabel'),
		detail: current.name,
		blocks: current.blocks,
		subject: current.subject,
	};
	isCompareLoading.value = true;
	try {
		const state = await loadState(version._id);
		if (request !== compareRequest) return;
		compareBefore.value = {
			label: triggerLabel(version.trigger),
			detail: absoluteTime(version.createdAt),
			blocks: state.blocks,
			subject: state.subject,
		};
	} catch {
		if (request !== compareRequest) return;
		compareVersion.value = null;
		showToast(t('components.email.templateHistoryPanel.loadFailed'), 'error');
	} finally {
		if (request === compareRequest) isCompareLoading.value = false;
	}
}

// ── Restore ────────────────────────────────────────────────────────────────

const pendingRestore = ref<VersionSummary | null>(null);
const isRestoring = ref(false);

function requestRestore(version: VersionSummary) {
	// Restoring is undoable, but it still replaces whatever is on the canvas —
	// worth one confirmation when that canvas holds unsaved work.
	if (props.hasUnsavedChanges) {
		// One dialog at a time: the confirmation shares the modal layer with the
		// preview, so stacking it on top would leave two backdrops and two focus
		// traps. Close the preview first — cancelling still leaves the history
		// panel open behind it. The same goes for the comparison.
		previewVersion.value = null;
		isCompareOpen.value = false;
		pendingRestore.value = version;
		loadState(version._id).catch(() => {});
		return;
	}
	void applyRestore(version);
}

async function applyRestore(version: VersionSummary) {
	isRestoring.value = true;
	try {
		emit('restore', await loadState(version._id));
		isOpen.value = false;
		previewVersion.value = null;
		isCompareOpen.value = false;
		showToast(
			t(
				props.autosaves
					? 'components.email.templateHistoryPanel.restoredAutosave'
					: 'components.email.templateHistoryPanel.restored'
			)
		);
	} catch {
		showToast(t('components.email.templateHistoryPanel.restoreFailed'), 'error');
	} finally {
		isRestoring.value = false;
		pendingRestore.value = null;
	}
}

// ── Panel chrome (mirrors ShareLinksPopover) ───────────────────────────────

const hasOverlay = () =>
	previewVersion.value !== null || compareVersion.value !== null || pendingRestore.value !== null;

// The panel is fixed to the trigger's position; a resize moves the trigger,
// so the position is read again then instead of once at open.
const layoutTick = ref(0);
const onResize = () => {
	layoutTick.value += 1;
};
const panelTopPx = computed(() => {
	void layoutTick.value;
	return triggerRef.value ? `${triggerRef.value.getBoundingClientRect().bottom + 8}px` : '0';
});
const panelRightPx = computed(() => {
	void layoutTick.value;
	if (!triggerRef.value) return '0';
	return `${document.documentElement.clientWidth - triggerRef.value.getBoundingClientRect().right}px`;
});

useClickOutside([panelRef, triggerRef], () => {
	// The preview and compare modals teleport outside the panel; closing the
	// panel behind them would strand their restore buttons.
	if (isOpen.value && !hasOverlay()) isOpen.value = false;
});

const handleEscape = (event: KeyboardEvent) => {
	// Escape belongs to whichever overlay sits on top of the panel.
	if (event.key === 'Escape' && !hasOverlay()) isOpen.value = false;
};
watch(isOpen, async (open) => {
	// oxlint-disable-next-line owlat/no-raw-keydown-listener -- Escape closes the panel
	if (open) document.addEventListener('keydown', handleEscape);
	else document.removeEventListener('keydown', handleEscape);
	if (open) {
		window.addEventListener('resize', onResize);
		// Teleported to <body>: without moving focus, a keyboard user would
		// have to tab past the rest of the toolbar to reach it.
		await nextTick();
		panelRef.value?.focus();
	} else {
		window.removeEventListener('resize', onResize);
		if (
			panelRef.value?.contains(document.activeElement) ||
			document.activeElement === document.body
		) {
			triggerRef.value?.querySelector<HTMLElement>('button')?.focus();
		}
	}
});
onUnmounted(() => {
	document.removeEventListener('keydown', handleEscape);
	window.removeEventListener('resize', onResize);
});
</script>

<template>
	<div class="relative inline-block">
		<div ref="triggerRef">
			<UiTooltip :text="t('components.email.templateHistoryPanel.triggerTitle')">
				<UiButton variant="outline" size="sm" @click.stop="isOpen = !isOpen">
					<template #iconLeft>
						<HistoryIcon class="w-4 h-4" />
					</template>
					<!-- Icon-only below 2xl, where the builder toolbar is short of room;
					     the label stays the accessible name. -->
					<span class="max-2xl:sr-only">{{
						t('components.email.templateHistoryPanel.trigger')
					}}</span>
				</UiButton>
			</UiTooltip>
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
					role="dialog"
					:aria-labelledby="panelTitleId"
					tabindex="-1"
					class="fixed z-50 w-96 max-w-[calc(100vw-2rem)] bg-bg-elevated border border-border-subtle rounded-lg shadow-lg focus:outline-none"
					:style="{ top: panelTopPx, right: panelRightPx }"
				>
					<div class="p-3 border-b border-border-subtle">
						<h3 :id="panelTitleId" class="text-sm font-medium text-text-primary">
							{{ t('components.email.templateHistoryPanel.title') }}
						</h3>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('components.email.templateHistoryPanel.subtitle') }}
						</p>
					</div>

					<div class="max-h-96 overflow-y-auto">
						<!-- A failed read is not "no versions yet". -->
						<div v-if="versionsError" class="p-3">
							<UiQueryBoundary :error="versionsError" @retry="refetchVersions" />
						</div>

						<div v-else-if="isLoading" class="px-3 py-6 flex justify-center">
							<UiSpinner />
						</div>

						<div
							v-else-if="!versions?.length"
							class="px-3 py-4 text-center text-xs text-text-tertiary"
						>
							{{ t('components.email.templateHistoryPanel.empty') }}
						</div>

						<template v-else>
							<div
								v-for="version in versions"
								:key="version._id"
								class="px-3 py-2 border-b border-border-subtle last:border-b-0 flex items-center justify-between gap-2 hover:bg-bg-surface transition-colors"
							>
								<div class="min-w-0">
									<div class="flex items-center gap-1.5">
										<component
											:is="TRIGGER_ICONS[version.trigger]"
											class="w-3.5 h-3.5 text-text-tertiary shrink-0"
										/>
										<span class="text-xs font-medium text-text-primary">
											{{ triggerLabel(version.trigger) }}
										</span>
										<span
											class="text-xs text-text-tertiary"
											:title="absoluteTime(version.createdAt)"
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
									<UiTooltip :text="t('components.email.templateHistoryPanel.previewAction')">
										<button
											type="button"
											class="p-1 rounded hover:bg-bg-surface text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:p-2.5"
											:aria-label="
												t('components.email.templateHistoryPanel.previewActionNamed', {
													version: versionLabel(version),
												})
											"
											@click="openPreview(version)"
										>
											<EyeIcon class="w-3.5 h-3.5" />
										</button>
									</UiTooltip>
									<UiTooltip
										v-if="readCurrent"
										:text="t('components.email.templateHistoryPanel.compareAction')"
									>
										<button
											type="button"
											class="p-1 rounded hover:bg-bg-surface text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:p-2.5"
											:aria-label="
												t('components.email.templateHistoryPanel.compareActionNamed', {
													version: versionLabel(version),
												})
											"
											@click="openCompare(version)"
										>
											<GitCompareIcon class="w-3.5 h-3.5" />
										</button>
									</UiTooltip>
									<UiTooltip :text="t('components.email.templateHistoryPanel.restoreAction')">
										<button
											type="button"
											class="p-1 rounded hover:bg-bg-surface text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand pointer-coarse:p-2.5"
											:aria-label="
												t('components.email.templateHistoryPanel.restoreActionNamed', {
													version: versionLabel(version),
												})
											"
											:disabled="isRestoring"
											@click="requestRestore(version)"
										>
											<RotateLeftIcon class="w-3.5 h-3.5" />
										</button>
									</UiTooltip>
								</div>
							</div>
						</template>
					</div>
				</div>
			</Transition>
		</Teleport>

		<!-- Snapshot preview -->
		<EmailTemplateHistoryPreviewModal
			v-model:open="isPreviewOpen"
			:version="previewVersion"
			:trigger-label="previewVersion ? triggerLabel(previewVersion.trigger) : ''"
			:html="previewHtml"
			:loading="isPreviewLoading"
			:can-compare="!!readCurrent"
			:restoring="isRestoring"
			@compare="previewVersion && openCompare(previewVersion)"
			@restore="previewVersion && requestRestore(previewVersion)"
		/>

		<EmailTemplateCompareModal
			v-model:open="isCompareOpen"
			:before="compareBefore"
			:after="compareAfter"
			:loading="isCompareLoading"
		>
			<template #actions>
				<UiButton
					:loading="isRestoring"
					:disabled="!compareVersion || isCompareLoading"
					@click="compareVersion && requestRestore(compareVersion)"
				>
					<template #iconLeft>
						<RotateLeftIcon class="w-4 h-4" />
					</template>
					{{ t('components.email.templateHistoryPanel.restore') }}
				</UiButton>
			</template>
		</EmailTemplateCompareModal>

		<UiConfirmationDialog
			:open="pendingRestore !== null"
			:title="t('components.email.templateHistoryPanel.confirmTitle')"
			:description="t('components.email.templateHistoryPanel.confirmDescription')"
			:confirm-text="t('components.email.templateHistoryPanel.confirmAction')"
			variant="warning"
			:is-loading="isRestoring"
			@update:open="
				(open: boolean) => {
					if (!open) pendingRestore = null;
				}
			"
			@confirm="pendingRestore && applyRestore(pendingRestore)"
			@cancel="pendingRestore = null"
		/>
	</div>
</template>
