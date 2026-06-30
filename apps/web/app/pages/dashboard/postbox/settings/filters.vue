<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import type {
	MailFilterCondition,
	FilterAction,
} from '~/composables/postbox/usePostboxFilters';

useHead({ title: 'Filters — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

const { filters, isLoading, create, update, setEnabled, remove } =
	usePostboxFilters(mailboxId);

interface DraftFilter {
	id: Id<'mailFilters'> | null;
	name: string;
	conditions: MailFilterCondition[];
	actions: FilterAction[];
	stopProcessing: boolean;
}

const editor = ref<DraftFilter | null>(null);

function startCreate() {
	editor.value = {
		id: null,
		name: '',
		conditions: [{ field: 'from', op: 'contains', value: '' }],
		actions: [{ type: 'addLabel' }],
		stopProcessing: false,
	};
}

function startEdit(f: (typeof filters.value)[number]) {
	editor.value = {
		id: f._id,
		name: f.name,
		conditions: f.conditions as MailFilterCondition[],
		actions: f.actions as FilterAction[],
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
			stopProcessing: payload.stopProcessing,
		});
	} else {
		await create({
			name: payload.name,
			conditions: payload.conditions,
			actions: payload.actions,
			stopProcessing: payload.stopProcessing,
		});
	}
	editor.value = null;
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
	<div class="p-6 lg:p-8 max-w-3xl mx-auto">
		<NuxtLink
			to="/dashboard/postbox/settings"
			class="text-sm text-text-secondary inline-flex items-center gap-1 hover:text-text-primary mb-4"
		>
			<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
			Back to settings
		</NuxtLink>

		<header class="mb-6 flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-semibold">Filters</h1>
				<p class="text-text-secondary mt-1">
					Auto-route inbound mail to folders, apply labels, mark read, or
					forward.
				</p>
			</div>
			<button
				v-if="mailboxId && !editor"
				type="button"
				class="btn btn-primary"
				@click="startCreate"
			>
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				New filter
			</button>
		</header>

		<section v-if="editor" class="card p-5 mb-6">
			<PostboxFilterRuleBuilder
				v-model="editor"
				:mailbox-id="mailboxId!"
			/>
			<div class="flex items-center justify-end gap-2 mt-5">
				<button type="button" class="btn btn-ghost" @click="editor = null">
					Cancel
				</button>
				<button
					type="button"
					class="btn btn-primary"
					:disabled="
						!editor.name.trim() ||
						editor.conditions.length === 0 ||
						editor.actions.length === 0
					"
					@click="save"
				>
					{{ editor.id ? 'Save changes' : 'Create filter' }}
				</button>
			</div>
		</section>

		<section v-if="mailboxId" class="card !p-0">
			<header class="px-5 py-3 border-b border-border-subtle">
				<h2 class="font-semibold">Active filters</h2>
			</header>
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<div
				v-else-if="filters.length === 0"
				class="p-8 text-center text-text-secondary"
			>
				No filters yet. Create your first one to start routing mail.
			</div>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="f in filters"
					:key="f._id"
					class="px-5 py-3 flex items-center justify-between gap-3"
				>
					<div class="flex-1 min-w-0">
						<div class="flex items-center gap-2">
							<span class="font-medium">{{ f.name }}</span>
							<span
								v-if="!f.isEnabled"
								class="text-xs px-1.5 py-0.5 rounded bg-bg-surface text-text-tertiary"
							>Disabled</span>
							<span
								v-if="f.stopProcessing"
								class="text-xs px-1.5 py-0.5 rounded bg-bg-surface text-text-secondary"
								title="Stops further filters"
							>Stop</span>
						</div>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ f.conditions.length }} condition(s) · {{ f.actions.length }} action(s)
						</p>
					</div>
					<label class="flex items-center gap-1.5 text-sm">
						<input
							type="checkbox"
							:checked="f.isEnabled"
							@change="setEnabled(f._id, ($event.target as HTMLInputElement).checked)"
						/>
						Enabled
					</label>
					<button
						type="button"
						class="btn btn-ghost"
						@click="startEdit(f)"
					>
						Edit
					</button>
					<button
						type="button"
						class="btn btn-ghost text-error"
						@click="filterToRemove = f._id"
					>
						Delete
					</button>
				</li>
			</ul>
		</section>

		<div v-if="!mailboxId && !mailboxesLoading" class="card p-6 text-center text-text-secondary">
			No mailbox configured.
		</div>

		<UiConfirmationDialog
			:open="!!filterToRemove"
			variant="danger"
			title="Delete filter?"
			description="This filter will stop routing inbound mail. This action cannot be undone."
			confirm-text="Delete filter"
			:is-loading="isRemovingFilter"
			@update:open="(v: boolean) => !v && (filterToRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
