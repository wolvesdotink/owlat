<script setup lang="ts">
/**
 * "Pick from Files" for a file question (plan §06): a small dialog over the
 * files the person can already read, searchable by name.
 *
 *  - Files: the organization's Files library (`semanticFiles`), newest first,
 *    or its full-text search. A row whose bytes the retention sweep released
 *    has nothing left to attach and is not offered.
 *  - Mail attachments: this inbox's attachment index, newest first, or by
 *    filename.
 *
 * Picking returns the reference the answer carries; the server re-checks read
 * access before it copies anything onto the draft.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatCompactFileSize } from '~/utils/formatters';

export interface PickedFile {
	source: 'semanticFile' | 'mailAttachment';
	id: string;
	filename: string;
}

/** Rows per source: a picker, not a browser. */
const PAGE = 20;

const props = defineProps<{
	open: boolean;
	/** The inbox whose mail attachments are offered. */
	mailboxId?: Id<'mailboxes'>;
}>();

const emit = defineEmits<{
	'update:open': [open: boolean];
	pick: [file: PickedFile];
}>();

const { t } = useI18n();
const { query, debouncedQuery } = useDebouncedSearch(250);

const filesList = usePaginatedQuery(
	api.semanticFiles.list,
	() => (props.open && !debouncedQuery.value ? {} : 'skip'),
	{ initialNumItems: PAGE }
);
const filesSearch = usePaginatedQuery(
	api.semanticFiles.search,
	() => (props.open && debouncedQuery.value ? { query: debouncedQuery.value } : 'skip'),
	{ initialNumItems: PAGE }
);
const files = computed(() =>
	(debouncedQuery.value ? filesSearch.results.value : filesList.results.value)
		.filter((f) => f.storageId)
		.map((f) => ({
			key: `sf:${f._id}`,
			ref: { source: 'semanticFile' as const, id: f._id, filename: f.filename },
			label: f.title?.trim() || f.filename,
			detail: formatCompactFileSize(f.fileSize),
		}))
);

const mailQuery = useConvexQuery(api.mail.mailbox.attachments.list, () =>
	props.open && props.mailboxId
		? {
				mailboxId: props.mailboxId,
				limit: PAGE,
				...(debouncedQuery.value ? { filenameQuery: debouncedQuery.value } : {}),
			}
		: ('skip' as const)
);
const mailFiles = computed(() =>
	(mailQuery.data.value?.files ?? []).map((f) => ({
		key: `ma:${f._id}`,
		ref: { source: 'mailAttachment' as const, id: f._id, filename: f.filename },
		label: f.filename,
		detail: `${formatCompactFileSize(f.size)} · ${f.fromName || f.fromAddress}`,
	}))
);

const sections = computed(() => [
	{ id: 'files', title: t('components.answer.filePicker.files'), rows: files.value },
	{ id: 'mail', title: t('components.answer.filePicker.mail'), rows: mailFiles.value },
]);
const isEmpty = computed(() => files.value.length === 0 && mailFiles.value.length === 0);

function pick(ref: PickedFile) {
	emit('pick', ref);
	emit('update:open', false);
}

watch(
	() => props.open,
	(open) => {
		if (!open) query.value = '';
	}
);

const searchId = useId();
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.answer.filePicker.title')"
		size="md"
		@update:open="emit('update:open', $event)"
	>
		<label :for="searchId" class="sr-only">{{ t('components.answer.filePicker.search') }}</label>
		<input
			:id="searchId"
			v-model="query"
			type="search"
			class="input w-full"
			:placeholder="t('components.answer.filePicker.search')"
			data-testid="file-picker-search"
		/>
		<p v-if="isEmpty" class="mt-4 text-sm text-text-tertiary" data-testid="file-picker-empty">
			{{ t('components.answer.filePicker.empty') }}
		</p>
		<template v-for="section in sections" :key="section.id">
			<section v-if="section.rows.length > 0" class="mt-4">
				<h3 class="text-xs font-semibold text-text-secondary">{{ section.title }}</h3>
				<ul class="mt-1.5 max-h-56 space-y-0.5 overflow-y-auto">
					<li v-for="row in section.rows" :key="row.key">
						<button
							type="button"
							class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-bg-surface focus-visible:outline-2 focus-visible:outline-brand"
							data-testid="file-picker-row"
							@click="pick(row.ref)"
						>
							<Icon
								name="lucide:file"
								class="size-4 shrink-0 text-text-tertiary"
								aria-hidden="true"
							/>
							<span class="min-w-0 flex-1 truncate text-text-primary">{{ row.label }}</span>
							<span class="shrink-0 text-xs text-text-tertiary">{{ row.detail }}</span>
						</button>
					</li>
				</ul>
			</section>
		</template>
	</UiModal>
</template>
