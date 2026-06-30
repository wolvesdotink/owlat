<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type {
	MailFilterCondition,
	FilterAction,
} from '~/composables/postbox/usePostboxFilters';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	modelValue: {
		name: string;
		conditions: MailFilterCondition[];
		actions: FilterAction[];
		stopProcessing: boolean;
	};
}>();

const emit = defineEmits<{
	(
		e: 'update:modelValue',
		value: {
			name: string;
			conditions: MailFilterCondition[];
			actions: FilterAction[];
			stopProcessing: boolean;
		}
	): void;
}>();

const mailboxIdRef = computed(() => props.mailboxId);
const { folders } = usePostboxFolders(mailboxIdRef);
const { labels } = usePostboxLabels(mailboxIdRef);

const local = reactive(JSON.parse(JSON.stringify(props.modelValue)));

watch(local, (v) => emit('update:modelValue', JSON.parse(JSON.stringify(v))), {
	deep: true,
});

const FIELD_OPTIONS = [
	{ value: 'from', label: 'From' },
	{ value: 'to', label: 'To' },
	{ value: 'cc', label: 'Cc' },
	{ value: 'subject', label: 'Subject' },
	{ value: 'body', label: 'Body' },
	{ value: 'header', label: 'Header' },
	{ value: 'size', label: 'Size (bytes)' },
	{ value: 'hasAttachment', label: 'Has attachment' },
];

const STRING_OPS = [
	{ value: 'contains', label: 'contains' },
	{ value: 'notContains', label: "doesn't contain" },
	{ value: 'equals', label: 'equals' },
	{ value: 'matches', label: 'matches regex' },
];
const NUMBER_OPS = [
	{ value: 'greaterThan', label: '>' },
	{ value: 'lessThan', label: '<' },
];

function opsForField(field: string) {
	if (field === 'size') return NUMBER_OPS;
	if (field === 'hasAttachment') return [{ value: 'isTrue', label: 'is true' }];
	return STRING_OPS;
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
			<label for="local-name" class="text-sm font-medium block mb-1">Name</label>
			<input id="local-name"
				v-model="local.name"
				type="text"
				class="input w-full"
				placeholder="Newsletter triage"
			/>
		</div>

		<section>
			<header class="flex items-center justify-between mb-2">
				<h3 class="text-sm font-semibold">If all of these match…</h3>
				<button
					type="button"
					class="text-sm text-brand hover:underline"
					@click="addCondition"
				>
					+ Add condition
				</button>
			</header>
			<div class="space-y-2">
				<div
					v-for="(cond, idx) in local.conditions"
					:key="idx"
					class="flex items-center gap-2"
				>
					<select v-model="cond.field" class="input flex-shrink-0 w-36" @change="onFieldChange(cond)">
						<option v-for="opt in FIELD_OPTIONS" :key="opt.value" :value="opt.value">
							{{ opt.label }}
						</option>
					</select>
					<input
						v-if="cond.field === 'header'"
						v-model="cond.headerName"
						type="text"
						placeholder="X-Header-Name"
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
						placeholder="100000"
					/>
					<input
						v-else-if="cond.field !== 'hasAttachment'"
						v-model="cond.value"
						type="text"
						class="input flex-1"
						placeholder="value"
					/>
					<span v-else class="flex-1 text-text-tertiary text-sm">true</span>
					<button
						type="button"
						class="p-1 rounded hover:bg-error/10 text-error"
						@click="removeCondition(Number(idx))"
					 aria-label="Close">
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
				<p v-if="local.conditions.length === 0" class="text-xs text-text-tertiary">
					No conditions yet — at least one is required.
				</p>
			</div>
		</section>

		<section>
			<header class="flex items-center justify-between mb-2">
				<h3 class="text-sm font-semibold">Then do…</h3>
				<button
					type="button"
					class="text-sm text-brand hover:underline"
					@click="addAction"
				>
					+ Add action
				</button>
			</header>
			<div class="space-y-2">
				<div
					v-for="(action, idx) in local.actions"
					:key="idx"
					class="flex items-center gap-2"
				>
					<select v-model="action.type" class="input w-44 flex-shrink-0">
						<option value="moveToFolder">Move to folder</option>
						<option value="addLabel">Add label</option>
						<option value="markRead">Mark read</option>
						<option value="markFlagged">Star</option>
						<option value="forward">Forward to…</option>
						<option value="delete">Move to Trash</option>
						<option value="discard">Discard (silent drop)</option>
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
						placeholder="archive@example.com"
					/>
					<span v-else class="flex-1 text-xs text-text-tertiary" />
					<button
						type="button"
						class="p-1 rounded hover:bg-error/10 text-error"
						@click="removeAction(Number(idx))"
					 aria-label="Close">
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
				<p v-if="local.actions.length === 0" class="text-xs text-text-tertiary">
					No actions yet — at least one is required.
				</p>
			</div>
		</section>

		<label class="flex items-center gap-2 text-sm">
			<input v-model="local.stopProcessing" type="checkbox" />
			Stop applying further filters once this one matches
		</label>
	</div>
</template>
