<script setup lang="ts">
/**
 * Filters — the rule list and its editor.
 *
 * `priority` decided evaluation order from the beginning, and `stopProcessing`
 * makes that order load-bearing, but nothing could change it: a rule that
 * needed to run first could only be deleted and recreated. The list is now
 * drag-to-reorder with ▲/▼ buttons that write the same order, and each rule can
 * be run over the backlog it was written for.
 */

import type { Id } from '@owlat/api/dataModel';
import {
	hasRetroactiveActions,
	type FilterMatchType,
	type MailFilterCondition,
	type FilterAction,
} from '~/composables/postbox/usePostboxFilters';
import { moveSibling } from '~/utils/postboxReorder';
import { isPlainLanguageRule } from '~/composables/postbox/usePostboxRules';
import { ChevronDownIcon, ChevronUpIcon, PlusIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.filters.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const {
	currentMailbox,
	isLoading: mailboxesLoading,
	error: mailboxesError,
	refetch: refetchMailboxes,
} = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const {
	filters,
	isLoading,
	error: listError,
	refetch: refetchList,
	create,
	update,
	setEnabled,
	remove,
	reorder,
} = usePostboxFilters(mailboxId);

interface DraftFilter {
	id: Id<'mailFilters'> | null;
	name: string;
	conditions: MailFilterCondition[];
	actions: FilterAction[];
	matchType: FilterMatchType;
	stopProcessing: boolean;
}

const editor = ref<DraftFilter | null>(null);
const saving = ref(false);
const editorSection = ref<HTMLElement | null>(null);

// The editor opens above the list, so Edit on a lower row would otherwise open
// it off-screen with focus left on the button: bring it into view and focus
// its first field.
watch(
	() => editor.value !== null,
	async (isOpen) => {
		if (!isOpen) return;
		await nextTick();
		const section = editorSection.value;
		if (!section) return;
		section.scrollIntoView?.({ block: 'start' });
		section.querySelector<HTMLElement>('input, select, textarea')?.focus({ preventScroll: true });
	}
);

// Plain-language and AI rules live in their own section above (read on
// arrival) and run after the manual filters; this list is the rest.
const manualFilters = computed(() => filters.value.filter((f) => !isPlainLanguageRule(f)));
const ruleIds = computed(() =>
	filters.value.filter((f) => isPlainLanguageRule(f)).map((f) => f._id)
);
// Plain-language rules exist for personal mailboxes only.
const isPersonalMailbox = computed(() => currentMailbox.value?.scope !== 'shared');

function startCreate() {
	editor.value = {
		id: null,
		name: '',
		conditions: [{ field: 'from', op: 'contains', value: '' }],
		actions: [{ type: 'addLabel' }],
		matchType: 'all',
		stopProcessing: false,
	};
}

/**
 * Open the editor pre-filled from a message — the "create a filter from this"
 * entry point in the reader's overflow menu, which arrives here as query params
 * so the deep link is shareable and survives a reload.
 */
function startFromMessage(seed: { from?: string; subject?: string }) {
	const conditions: MailFilterCondition[] = [];
	if (seed.from) conditions.push({ field: 'from', op: 'contains', value: seed.from });
	if (seed.subject) conditions.push({ field: 'subject', op: 'contains', value: seed.subject });
	if (conditions.length === 0) return;
	editor.value = {
		id: null,
		// Named after the sender rather than left blank: the name is required to
		// save, and "mail from X" is what this rule is.
		name: seed.from
			? t('dashboard.preferences.filters.fromSenderName', { sender: seed.from })
			: (seed.subject ?? ''),
		conditions,
		actions: [{ type: 'addLabel' }],
		// Several seeded conditions describe ONE message, so AND is what the user
		// pointed at; match-any here would fire on every mail from the sender OR
		// with that subject.
		matchType: 'all',
		stopProcessing: false,
	};
}

// `?filterFrom=<address>&filterSubject=<subject>` is how the reader's overflow
// hands a message over; `?openFilter=<id>` is how the reader's accepted rule
// suggestion (idea 27) links to the rule it created. Read once on mount and
// cleared from the URL, so a reload does not reopen an editor the user already
// dismissed.
const route = useRoute();
onMounted(() => {
	const openId = route.query['openFilter'];
	if (typeof openId === 'string') {
		// The list may still be loading; watch once for the row rather than
		// silently dropping a deep link that arrived first.
		const stop = watch(
			filters,
			(rows) => {
				const found = rows.find((f) => f._id === openId);
				if (!found) return;
				startEdit(found);
				stop();
				void navigateTo({ query: {} }, { replace: true });
			},
			{ immediate: true }
		);
		return;
	}
	const from = route.query['filterFrom'];
	const subject = route.query['filterSubject'];
	if (!from && !subject) return;
	startFromMessage({
		from: typeof from === 'string' ? from : undefined,
		subject: typeof subject === 'string' ? subject : undefined,
	});
	void navigateTo({ query: {} }, { replace: true });
});

function startEdit(f: (typeof filters.value)[number]) {
	editor.value = {
		id: f._id,
		name: f.name,
		conditions: f.conditions as MailFilterCondition[],
		actions: f.actions as FilterAction[],
		// Absent means `all` — the pre-toggle meaning of every existing filter.
		matchType: (f.matchType ?? 'all') as FilterMatchType,
		stopProcessing: f.stopProcessing,
	};
}

async function save() {
	if (!editor.value || !mailboxId.value || saving.value) return;
	const payload = editor.value;
	if (!payload.name.trim()) return;
	if (payload.conditions.length === 0 || payload.actions.length === 0) return;
	saving.value = true;
	try {
		if (payload.id) {
			const result = await update(payload.id, {
				name: payload.name,
				conditions: payload.conditions,
				actions: payload.actions,
				matchType: payload.matchType,
				stopProcessing: payload.stopProcessing,
			});
			// A refused save keeps the editor and the rule in it, as for create.
			if (!result.ok) return;
		} else {
			const result = await create({
				name: payload.name,
				conditions: payload.conditions,
				actions: payload.actions,
				matchType: payload.matchType,
				stopProcessing: payload.stopProcessing,
			});
			// A refused create keeps the editor and the rule in it; the
			// operation has already said why.
			if (!result.ok) return;
		}
		editor.value = null;
	} finally {
		saving.value = false;
	}
}

// ── Run order ──────────────────────────────────────────────────────────────
// `filters` is read off the by_mailbox_and_priority index, so the list order IS
// the evaluation order and reordering the list is the whole feature.
const draggingId = ref<Id<'mailFilters'> | null>(null);

async function moveFilter(filterId: Id<'mailFilters'>, delta: -1 | 1) {
	const ids = manualFilters.value.map((f) => f._id);
	const next = moveSibling(ids, filterId, delta);
	if (next.every((id, i) => id === ids[i])) return;
	await reorder([...(next as Id<'mailFilters'>[]), ...ruleIds.value]);
}

async function dropOn(targetId: Id<'mailFilters'>) {
	const sourceId = draggingId.value;
	draggingId.value = null;
	if (!sourceId || sourceId === targetId) return;
	const ids = manualFilters.value.map((f) => f._id).filter((id) => id !== sourceId);
	const at = ids.indexOf(targetId);
	ids.splice(at === -1 ? ids.length : at, 0, sourceId);
	await reorder([...ids, ...ruleIds.value]);
}

const filterToRemove = ref<Id<'mailFilters'> | null>(null);
const isRemovingFilter = ref(false);

async function confirmRemove() {
	const id = filterToRemove.value;
	if (!id) return;
	isRemovingFilter.value = true;
	try {
		await remove(id);
	} finally {
		isRemovingFilter.value = false;
		filterToRemove.value = null;
	}
}
</script>

<template>
	<div>
		<!-- The page's own intro leads, as on every Preferences page; the
		     plain-language rules card follows it as its own section. -->
		<header
			class="mb-6 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
		>
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.filters.intro') }}
			</p>
			<UiButton v-if="mailboxId && !editor" type="button" class="shrink-0" @click="startCreate">
				<PlusIcon class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.filters.newFilter') }}
			</UiButton>
		</header>

		<PostboxPlainRules
			v-if="mailboxId && isPersonalMailbox && !editor"
			:mailbox-id="mailboxId"
			:filters="filters"
			@toggle="setEnabled"
			@remove="(id: Id<'mailFilters'>) => (filterToRemove = id)"
		/>

		<section v-if="editor" ref="editorSection" class="card p-5 mb-6 scroll-mt-6">
			<PostboxFilterRuleBuilder v-model="editor" :mailbox-id="mailboxId!" />
			<div class="flex items-center justify-end gap-2 mt-5">
				<UiButton variant="ghost" type="button" :disabled="saving" @click="editor = null">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					type="button"
					:disabled="
						!editor.name.trim() || editor.conditions.length === 0 || editor.actions.length === 0
					"
					:loading="saving"
					@click="save"
				>
					{{
						editor.id
							? t('dashboard.preferences.filters.saveChanges')
							: t('dashboard.preferences.filters.createFilter')
					}}
				</UiButton>
			</div>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">{{ t('dashboard.preferences.filters.activeFilters') }}</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<SpinnerIcon class="w-5 h-5 text-text-tertiary" />
			</div>
			<!-- A failed read is not an empty list. -->
			<UiQueryBoundary v-else-if="listError" :error="listError" @retry="refetchList" />
			<div v-else-if="manualFilters.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.filters.empty') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="(f, index) in manualFilters"
					:key="f._id"
					class="px-5 py-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2"
					:class="{ 'opacity-50': draggingId === f._id }"
					draggable="true"
					@dragstart="draggingId = f._id"
					@dragover.prevent
					@drop.prevent="dropOn(f._id)"
					@dragend="draggingId = null"
				>
					<!-- The ▲/▼ pair is the keyboard-reachable equivalent of the drag:
					     both write the same whole-run order. The ends are disabled, since
					     the first rule cannot run any earlier. -->
					<div class="flex flex-[1_1_16rem] min-w-0 items-center gap-3">
						<span class="flex flex-col shrink-0">
							<UiButton
								variant="ghost"
								size="sm"
								class="min-h-6 px-1 py-0.5"
								:disabled="index === 0"
								:aria-label="t('dashboard.preferences.filters.moveUp', { name: f.name })"
								@click="moveFilter(f._id, -1)"
							>
								<ChevronUpIcon class="w-4 h-4" />
							</UiButton>
							<UiButton
								variant="ghost"
								size="sm"
								class="min-h-6 px-1 py-0.5"
								:disabled="index === manualFilters.length - 1"
								:aria-label="t('dashboard.preferences.filters.moveDown', { name: f.name })"
								@click="moveFilter(f._id, 1)"
							>
								<ChevronDownIcon class="w-4 h-4" />
							</UiButton>
						</span>
						<div class="flex-1 min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<span class="font-medium break-words">{{ f.name }}</span>
								<UiBadge v-if="!f.isEnabled" variant="neutral">{{ t('common.disabled') }}</UiBadge>
								<UiBadge
									v-if="f.stopProcessing"
									variant="neutral"
									:title="t('dashboard.preferences.filters.stopTitle')"
									>{{ t('dashboard.preferences.filters.stopBadge') }}</UiBadge
								>
							</div>
							<p class="text-xs text-text-tertiary mt-0.5">
								{{
									t(
										f.matchType === 'any'
											? 'dashboard.preferences.filters.ruleSummaryAny'
											: 'dashboard.preferences.filters.ruleSummary',
										{
											conditions: f.conditions.length,
											actions: f.actions.length,
										}
									)
								}}
							</p>
							<PostboxFilterRunControl
								class="mt-1"
								:filter-id="f._id"
								:can-run="hasRetroactiveActions(f.actions as FilterAction[])"
							/>
						</div>
					</div>
					<div class="flex flex-wrap items-center gap-1 shrink-0">
						<span class="flex items-center gap-1.5 text-sm mr-1">
							<UiSwitch
								:model-value="f.isEnabled"
								:label="`${t('common.enabled')}: ${f.name}`"
								@update:model-value="(on: boolean) => setEnabled(f._id, on)"
							/>
							<span aria-hidden="true">{{ t('common.enabled') }}</span>
						</span>
						<UiButton
							variant="ghost"
							size="sm"
							type="button"
							:aria-label="`${t('common.edit')}: ${f.name}`"
							@click="startEdit(f)"
						>
							{{ t('common.edit') }}
						</UiButton>
						<UiButton
							variant="danger-ghost"
							size="sm"
							type="button"
							:aria-label="`${t('common.delete')}: ${f.name}`"
							@click="filterToRemove = f._id"
						>
							{{ t('common.delete') }}
						</UiButton>
					</div>
				</li>
			</ul>
		</section>

		<UiQueryBoundary
			v-if="!mailboxId && mailboxesError"
			:error="mailboxesError"
			@retry="refetchMailboxes"
		/>
		<div
			v-else-if="!mailboxId && !mailboxesLoading"
			class="card p-6 text-center text-text-secondary"
		>
			{{ t('dashboard.preferences.filters.noMailbox') }}
		</div>

		<UiConfirmationDialog
			:open="!!filterToRemove"
			variant="danger"
			:title="t('dashboard.preferences.filters.deleteTitle')"
			:description="t('dashboard.preferences.filters.deleteDescription')"
			:confirm-text="t('dashboard.preferences.filters.deleteConfirm')"
			:is-loading="isRemovingFilter"
			@update:open="(v: boolean) => !v && (filterToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
