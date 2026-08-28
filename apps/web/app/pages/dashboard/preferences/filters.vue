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

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.filters.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const { filters, isLoading, create, update, setEnabled, remove, reorder } =
	usePostboxFilters(mailboxId);

interface DraftFilter {
	id: Id<'mailFilters'> | null;
	name: string;
	conditions: MailFilterCondition[];
	actions: FilterAction[];
	matchType: FilterMatchType;
	stopProcessing: boolean;
}

const editor = ref<DraftFilter | null>(null);

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
// hands a message over. Read once on mount and cleared from the URL, so a
// reload does not reopen an editor the user already dismissed.
const route = useRoute();
onMounted(() => {
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
	if (!editor.value || !mailboxId.value) return;
	const payload = editor.value;
	if (!payload.name.trim()) return;
	if (payload.conditions.length === 0 || payload.actions.length === 0) return;
	if (payload.id) {
		await update(payload.id, {
			name: payload.name,
			conditions: payload.conditions,
			actions: payload.actions,
			matchType: payload.matchType,
			stopProcessing: payload.stopProcessing,
		});
	} else {
		await create({
			name: payload.name,
			conditions: payload.conditions,
			actions: payload.actions,
			matchType: payload.matchType,
			stopProcessing: payload.stopProcessing,
		});
	}
	editor.value = null;
}

// ── Run order ──────────────────────────────────────────────────────────────
// `filters` is read off the by_mailbox_and_priority index, so the list order IS
// the evaluation order and reordering the list is the whole feature.
const draggingId = ref<Id<'mailFilters'> | null>(null);

async function moveFilter(filterId: Id<'mailFilters'>, delta: -1 | 1) {
	const ids = filters.value.map((f) => f._id);
	const next = moveSibling(ids, filterId, delta);
	if (next.every((id, i) => id === ids[i])) return;
	await reorder(next as Id<'mailFilters'>[]);
}

async function dropOn(targetId: Id<'mailFilters'>) {
	const sourceId = draggingId.value;
	draggingId.value = null;
	if (!sourceId || sourceId === targetId) return;
	const ids = filters.value.map((f) => f._id).filter((id) => id !== sourceId);
	const at = ids.indexOf(targetId);
	ids.splice(at === -1 ? ids.length : at, 0, sourceId);
	await reorder(ids as Id<'mailFilters'>[]);
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
		<header class="mb-6 flex items-center justify-between gap-4">
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.filters.intro') }}
			</p>
			<UiButton v-if="mailboxId && !editor" type="button" @click="startCreate">
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.preferences.filters.newFilter') }}
			</UiButton>
		</header>

		<section v-if="editor" class="card p-5 mb-6">
			<PostboxFilterRuleBuilder v-model="editor" :mailbox-id="mailboxId!" />
			<div class="flex items-center justify-end gap-2 mt-5">
				<UiButton variant="ghost" type="button" @click="editor = null">
					{{ t('common.cancel') }}
				</UiButton>
				<UiButton
					type="button"
					:disabled="
						!editor.name.trim() || editor.conditions.length === 0 || editor.actions.length === 0
					"
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
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary" />
			</div>
			<div v-else-if="filters.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.filters.empty') }}
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="f in filters"
					:key="f._id"
					class="px-5 py-3 flex items-center justify-between gap-3"
					:class="{ 'opacity-50': draggingId === f._id }"
					draggable="true"
					@dragstart="draggingId = f._id"
					@dragover.prevent
					@drop.prevent="dropOn(f._id)"
					@dragend="draggingId = null"
				>
					<!-- The ▲/▼ pair is the keyboard-reachable equivalent of the drag:
					     both write the same whole-run order. -->
					<span class="flex flex-col flex-shrink-0">
						<button
							type="button"
							class="p-0.5 text-text-tertiary hover:text-text-primary"
							:aria-label="t('dashboard.preferences.filters.moveUp', { name: f.name })"
							@click="moveFilter(f._id, -1)"
						>
							<Icon name="lucide:chevron-up" class="w-3.5 h-3.5" />
						</button>
						<button
							type="button"
							class="p-0.5 text-text-tertiary hover:text-text-primary"
							:aria-label="t('dashboard.preferences.filters.moveDown', { name: f.name })"
							@click="moveFilter(f._id, 1)"
						>
							<Icon name="lucide:chevron-down" class="w-3.5 h-3.5" />
						</button>
					</span>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="font-medium">{{ f.name }}</span>
							<span
								v-if="!f.isEnabled"
								class="text-xs px-1.5 py-0.5 rounded bg-bg-surface text-text-tertiary"
								>{{ t('common.disabled') }}</span
							>
							<span
								v-if="f.stopProcessing"
								class="text-xs px-1.5 py-0.5 rounded bg-bg-surface text-text-secondary"
								:title="t('dashboard.preferences.filters.stopTitle')"
								>{{ t('dashboard.preferences.filters.stopBadge') }}</span
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
					<label class="flex items-center gap-1.5 text-sm">
						<input
							type="checkbox"
							:checked="f.isEnabled"
							@change="setEnabled(f._id, ($event.target as HTMLInputElement).checked)"
						/>
						{{ t('common.enabled') }}
					</label>
					<UiButton variant="ghost" type="button" @click="startEdit(f)">
						{{ t('common.edit') }}
					</UiButton>
					<UiButton
						variant="ghost"
						type="button"
						class="text-error"
						@click="filterToRemove = f._id"
					>
						{{ t('common.delete') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
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
