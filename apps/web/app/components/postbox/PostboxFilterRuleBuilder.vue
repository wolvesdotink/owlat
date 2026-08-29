<script setup lang="ts">
/**
 * The filter editor.
 *
 * Two things beyond the plain condition/action rows (idea 39): the match-any
 * toggle — ONE grouping level, because a mixed AND/OR tree is a second grammar
 * and "define two filters" is still the escape hatch — and a dry-run preview
 * that runs the DRAFT conditions over recent mail through the same predicate
 * delivery uses. A preview computed by a parallel implementation would be worth
 * less than no preview at all, so the server evaluates it.
 */

import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatCompactRelativeTime } from '~/utils/formatters';
import type {
	FilterMatchType,
	MailFilterCondition,
	FilterAction,
} from '~/composables/postbox/usePostboxFilters';

interface FilterDraft {
	name: string;
	conditions: MailFilterCondition[];
	actions: FilterAction[];
	matchType: FilterMatchType;
	stopProcessing: boolean;
}

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	modelValue: FilterDraft;
}>();

const emit = defineEmits<{
	(e: 'update:modelValue', value: FilterDraft): void;
}>();

const { t } = useI18n();

const mailboxIdRef = computed(() => props.mailboxId);
const { folders } = usePostboxFolders(mailboxIdRef);
const { labels } = usePostboxLabels(mailboxIdRef);

/**
 * Same ceiling the server enforces on a `pinToSection` name — the name is the
 * section's identity and becomes an index key on every message it files, so the
 * input stops where the mutation would truncate rather than silently losing the
 * tail of what was typed.
 */
const MAX_SECTION_NAME_LENGTH = 60;

const local = reactive<FilterDraft>(JSON.parse(JSON.stringify(props.modelValue)));

watch(local, (v) => emit('update:modelValue', JSON.parse(JSON.stringify(v))), {
	deep: true,
});

// Option labels are computed, not frozen at setup, so a locale switch relabels
// the selects in place.
const FIELD_OPTIONS = computed(() => [
	{ value: 'from', label: t('components.postbox.postboxFilterRuleBuilder.fields.from') },
	{ value: 'to', label: t('components.postbox.postboxFilterRuleBuilder.fields.to') },
	{ value: 'cc', label: t('components.postbox.postboxFilterRuleBuilder.fields.cc') },
	{ value: 'subject', label: t('components.postbox.postboxFilterRuleBuilder.fields.subject') },
	{ value: 'body', label: t('components.postbox.postboxFilterRuleBuilder.fields.body') },
	{ value: 'header', label: t('components.postbox.postboxFilterRuleBuilder.fields.header') },
	{ value: 'size', label: t('components.postbox.postboxFilterRuleBuilder.fields.size') },
	{
		value: 'hasAttachment',
		label: t('components.postbox.postboxFilterRuleBuilder.fields.hasAttachment'),
	},
]);

const STRING_OPS = computed(() => [
	{ value: 'contains', label: t('components.postbox.postboxFilterRuleBuilder.ops.contains') },
	{
		value: 'notContains',
		label: t('components.postbox.postboxFilterRuleBuilder.ops.notContains'),
	},
	{ value: 'equals', label: t('components.postbox.postboxFilterRuleBuilder.ops.equals') },
	{ value: 'matches', label: t('components.postbox.postboxFilterRuleBuilder.ops.matches') },
]);
// The comparison symbols read the same in every language, and the catalog guard
// rejects `<`/`>` in a message, so they stay literals.
const NUMBER_OPS = [
	{ value: 'greaterThan', label: '>' },
	{ value: 'lessThan', label: '<' },
];

function opsForField(field: string) {
	if (field === 'size') return NUMBER_OPS;
	if (field === 'hasAttachment')
		return [
			{ value: 'isTrue', label: t('components.postbox.postboxFilterRuleBuilder.ops.isTrue') },
		];
	return STRING_OPS.value;
}

// When the field's value type changes, coerce the operator into the valid set
// and clear the now-irrelevant value. Otherwise a leftover op (e.g. subject +
// greaterThan, or size + contains) is type-guarded out by the backend evaluator
// and the filter silently never matches even though it looks valid in the list.
function onFieldChange(cond: MailFilterCondition) {
	const ops = opsForField(cond.field);
	if (!ops.some((o) => o.value === cond.op)) {
		cond.op = (ops[0]?.value ?? 'contains') as MailFilterCondition['op'];
	}
	if (cond.field === 'size') {
		cond.value = undefined;
	} else if (cond.field === 'hasAttachment') {
		cond.value = undefined;
		cond.valueNumber = undefined;
	} else {
		cond.valueNumber = undefined;
	}
}

function addCondition() {
	local.conditions.push({ field: 'from', op: 'contains', value: '' });
}
function removeCondition(idx: number) {
	local.conditions.splice(idx, 1);
}

// ── Dry run ────────────────────────────────────────────────────────────────
// Opt-in rather than always-on: a preview is a fixed recent-window scan, and
// firing one on every keystroke of a half-typed value would be a scan per
// character for an answer nobody asked for yet.
const previewOpen = ref(false);

const previewArgs = computed(() => {
	if (!previewOpen.value) return 'skip' as const;
	// A condition with no operand matches on an empty string, which would make
	// the preview claim the whole mailbox while the user is still typing.
	const usable = local.conditions.filter(
		(c) => c.field === 'hasAttachment' || (c.value ?? '').trim() !== '' || c.valueNumber != null
	);
	if (usable.length === 0) return 'skip' as const;
	return {
		mailboxId: props.mailboxId,
		conditions: usable,
		...(local.matchType === 'any' ? { matchType: 'any' as const } : {}),
	};
});

const { data: previewData, isLoading: previewLoading } = useConvexQuery(
	api.mail.filters.preview,
	() => previewArgs.value
);
const preview = computed(() => previewData.value ?? null);

function addAction() {
	local.actions.push({ type: 'addLabel' });
}
function removeAction(idx: number) {
	local.actions.splice(idx, 1);
}
</script>

<template>
	<div class="space-y-4">
		<div>
			<label for="local-name" class="text-sm font-medium block mb-1">{{ t('common.name') }}</label>
			<input
				id="local-name"
				v-model="local.name"
				type="text"
				class="input w-full"
				:placeholder="t('components.postbox.postboxFilterRuleBuilder.namePlaceholder')"
			/>
		</div>

		<section>
			<header class="flex items-center justify-between mb-2 gap-3">
				<h3 class="text-sm font-semibold">
					{{ t('components.postbox.postboxFilterRuleBuilder.conditionsHeading') }}
				</h3>
				<!-- ONE grouping level. `all` is the default and what every filter
				     written before this toggle means. -->
				<label class="flex items-center gap-1.5 text-xs text-text-secondary ml-auto">
					{{ t('components.postbox.postboxFilterRuleBuilder.matchLabel') }}
					<select
						v-model="local.matchType"
						class="input input-sm"
						:aria-label="t('components.postbox.postboxFilterRuleBuilder.matchLabel')"
					>
						<option value="all">
							{{ t('components.postbox.postboxFilterRuleBuilder.matchAll') }}
						</option>
						<option value="any">
							{{ t('components.postbox.postboxFilterRuleBuilder.matchAny') }}
						</option>
					</select>
				</label>
				<button type="button" class="text-sm text-brand hover:underline" @click="addCondition">
					{{ t('components.postbox.postboxFilterRuleBuilder.addCondition') }}
				</button>
			</header>
			<div class="space-y-2">
				<div v-for="(cond, idx) in local.conditions" :key="idx" class="flex items-center gap-2">
					<select
						v-model="cond.field"
						class="input flex-shrink-0 w-36"
						@change="onFieldChange(cond)"
					>
						<option v-for="opt in FIELD_OPTIONS" :key="opt.value" :value="opt.value">
							{{ opt.label }}
						</option>
					</select>
					<input
						v-if="cond.field === 'header'"
						v-model="cond.headerName"
						type="text"
						:placeholder="t('components.postbox.postboxFilterRuleBuilder.headerNamePlaceholder')"
						class="input w-40"
					/>
					<select v-model="cond.op" class="input w-32 flex-shrink-0">
						<option v-for="opt in opsForField(cond.field)" :key="opt.value" :value="opt.value">
							{{ opt.label }}
						</option>
					</select>
					<input
						v-if="cond.field === 'size'"
						v-model.number="cond.valueNumber"
						type="number"
						class="input flex-1"
						:placeholder="t('components.postbox.postboxFilterRuleBuilder.sizePlaceholder')"
					/>
					<input
						v-else-if="cond.field !== 'hasAttachment'"
						v-model="cond.value"
						type="text"
						class="input flex-1"
						:placeholder="t('components.postbox.postboxFilterRuleBuilder.valuePlaceholder')"
					/>
					<span v-else class="flex-1 text-text-tertiary text-sm">
						{{ t('components.postbox.postboxFilterRuleBuilder.trueValue') }}
					</span>
					<button
						type="button"
						class="p-1 rounded hover:bg-error/10 text-error"
						:aria-label="t('components.postbox.postboxFilterRuleBuilder.removeCondition')"
						@click="removeCondition(Number(idx))"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
				<p v-if="local.conditions.length === 0" class="text-xs text-text-tertiary">
					{{ t('components.postbox.postboxFilterRuleBuilder.noConditions') }}
				</p>
			</div>
		</section>

		<section>
			<header class="flex items-center justify-between mb-2">
				<h3 class="text-sm font-semibold">
					{{ t('components.postbox.postboxFilterRuleBuilder.actionsHeading') }}
				</h3>
				<button type="button" class="text-sm text-brand hover:underline" @click="addAction">
					{{ t('components.postbox.postboxFilterRuleBuilder.addAction') }}
				</button>
			</header>
			<div class="space-y-2">
				<div v-for="(action, idx) in local.actions" :key="idx" class="flex items-center gap-2">
					<select v-model="action.type" class="input w-44 flex-shrink-0">
						<option value="moveToFolder">
							{{ t('components.postbox.postboxFilterRuleBuilder.actions.moveToFolder') }}
						</option>
						<option value="addLabel">
							{{ t('components.postbox.postboxFilterRuleBuilder.actions.addLabel') }}
						</option>
						<option value="markRead">
							{{ t('components.postbox.postboxFilterRuleBuilder.actions.markRead') }}
						</option>
						<option value="markFlagged">
							{{ t('components.postbox.postboxFilterRuleBuilder.actions.markFlagged') }}
						</option>
						<option value="forward">
							{{ t('components.postbox.postboxFilterRuleBuilder.actions.forward') }}
						</option>
						<option value="delete">
							{{ t('components.postbox.postboxFilterRuleBuilder.actions.delete') }}
						</option>
						<!-- Split inbox (idea 24): the one action that REARRANGES the
						     inbox instead of emptying it — the message stays put and
						     gains a section. -->
						<option value="pinToSection">
							{{ t('components.postbox.postboxFilterRuleBuilder.actions.pinToSection') }}
						</option>
						<option value="discard">
							{{ t('components.postbox.postboxFilterRuleBuilder.actions.discard') }}
						</option>
					</select>
					<select
						v-if="action.type === 'moveToFolder'"
						v-model="action.folderId"
						class="input flex-1"
					>
						<option v-for="f in folders" :key="f._id" :value="f._id">
							{{ f.role ?? f.name }}
						</option>
					</select>
					<select
						v-else-if="action.type === 'addLabel'"
						v-model="action.labelId"
						class="input flex-1"
					>
						<option v-for="l in labels" :key="l._id" :value="l._id">
							{{ l.name }}
						</option>
					</select>
					<input
						v-else-if="action.type === 'forward'"
						v-model="action.forwardTo"
						type="text"
						class="input flex-1"
						:placeholder="t('components.postbox.postboxFilterRuleBuilder.forwardToPlaceholder')"
					/>
					<!-- Free text, not a picker: there is no section table. A section
					     exists exactly as long as an enabled rule names it, and typing
					     the same name in a second rule feeds the same section. -->
					<input
						v-else-if="action.type === 'pinToSection'"
						v-model="action.sectionName"
						type="text"
						class="input flex-1"
						:maxlength="MAX_SECTION_NAME_LENGTH"
						:placeholder="t('components.postbox.postboxFilterRuleBuilder.sectionNamePlaceholder')"
					/>
					<span v-else class="flex-1 text-xs text-text-tertiary" />
					<button
						type="button"
						class="p-1 rounded hover:bg-error/10 text-error"
						:aria-label="t('components.postbox.postboxFilterRuleBuilder.removeAction')"
						@click="removeAction(Number(idx))"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
				<p v-if="local.actions.length === 0" class="text-xs text-text-tertiary">
					{{ t('components.postbox.postboxFilterRuleBuilder.noActions') }}
				</p>
			</div>
		</section>

		<label class="flex items-center gap-2 text-sm">
			<input v-model="local.stopProcessing" type="checkbox" />
			{{ t('components.postbox.postboxFilterRuleBuilder.stopProcessing') }}
		</label>

		<!-- Dry run: what this rule would catch in recent mail, before it governs
		     anything. Opt-in, so a half-typed rule does not scan per keystroke. -->
		<section class="border-t border-border-subtle pt-3">
			<button
				type="button"
				class="text-sm text-brand hover:underline"
				:aria-expanded="previewOpen"
				@click="previewOpen = !previewOpen"
			>
				{{
					previewOpen
						? t('components.postbox.postboxFilterRuleBuilder.hidePreview')
						: t('components.postbox.postboxFilterRuleBuilder.showPreview')
				}}
			</button>
			<div v-if="previewOpen" class="mt-2">
				<div v-if="previewLoading" class="flex items-center gap-2 text-xs text-text-tertiary">
					<Icon
						name="lucide:loader-2"
						class="w-3.5 h-3.5 animate-spin motion-reduce:animate-none"
					/>
					{{ t('components.postbox.postboxFilterRuleBuilder.previewRunning') }}
				</div>
				<template v-else-if="preview">
					<p class="text-xs text-text-secondary">
						{{
							t('components.postbox.postboxFilterRuleBuilder.previewSummary', {
								count: preview.matchCount,
								scanned: preview.scanned,
							})
						}}
					</p>
					<ul v-if="preview.matches.length > 0" class="mt-1.5 space-y-1">
						<li
							v-for="match in preview.matches"
							:key="match.messageId"
							class="text-xs text-text-tertiary flex items-baseline gap-2 min-w-0"
						>
							<span class="truncate flex-1">{{ match.subject }}</span>
							<span class="truncate max-w-[10rem]">{{ match.fromAddress }}</span>
							<span class="flex-shrink-0">{{ formatCompactRelativeTime(match.receivedAt) }}</span>
						</li>
					</ul>
				</template>
				<p v-else class="text-xs text-text-tertiary">
					{{ t('components.postbox.postboxFilterRuleBuilder.previewNeedsValue') }}
				</p>
			</div>
		</section>
	</div>
</template>
