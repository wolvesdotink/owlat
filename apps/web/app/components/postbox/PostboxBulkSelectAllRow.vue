<script setup lang="ts">
/**
 * The whole-folder select-all escape hatch, inside the bulk bar.
 *
 * The loaded page is 50 messages and "select all" over 4 000 is a different
 * promise, so whole-folder selection goes through a server-side id query rather
 * than pretending the page is the folder. It is offered only once the page
 * itself is fully selected, so it reads as "and the rest" rather than as a
 * second, competing select-all.
 *
 * It used to sit in the list header, a row below the folder title, describing a
 * selection rendered somewhere else. It now sits under the verbs it grows, on
 * the surface that already says how many messages are selected.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { headerSelectionState } from '~/utils/postboxRangeSelect';

const { t } = useI18n();

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/** The folder scope "everything" means. One of role or id is always set. */
	folderRole?: string;
	folderId?: Id<'mailFolders'>;
	/** The list's arrival direction, so a capped answer keeps the rows on screen. */
	sortOrder?: string;
	/** Ids of the rows the list currently has loaded, in render order. */
	pageIds?: string[];
	/**
	 * False when the rendered rows are a narrower set than the folder scope —
	 * i.e. a triage chip (unread / starred / attachments) is filtering the list.
	 * The whole-folder query below narrows by folder alone, so under a chip it
	 * would silently select rows the chip is hiding. Absent means unfiltered,
	 * which is what every non-chip caller is.
	 */
	scopeMatchesList?: boolean;
}>();

const mailboxIdRef = computed(() => props.mailboxId);
const bulk = usePostboxBulkActions(mailboxIdRef);
const pageIds = computed(() => props.pageIds ?? []);
/** Only meaningful once every loaded row is picked — see the header checkbox. */
const pageFullySelected = computed(
	() => pageIds.value.length > 0 && headerSelectionState(pageIds.value, bulk.selected.value) === 'all'
);

const loadingAllMatching = ref(false);
/**
 * The escape hatch is only honest when the rows on screen ARE the folder scope.
 * Withhold it under a chip instead of lying: the page-level selection (and its
 * count) stays available.
 */
const canSelectAllMatching = computed(() => props.scopeMatchesList !== false);

/**
 * Replace the page selection with every message the current folder scope holds.
 * One-shot read, not a subscription: the answer is consumed once by the bulk
 * action that follows, and a live id list of a whole folder would re-run on
 * every arrival.
 */
async function selectAllMatching() {
	if (loadingAllMatching.value || !canSelectAllMatching.value) return;
	if (!props.folderId && !props.folderRole) return;
	loadingAllMatching.value = true;
	try {
		const result = await requireConvex().query(api.mail.mailbox.selection.listMessageIds, {
			mailboxId: props.mailboxId,
			...(props.folderId ? { folderId: props.folderId } : { folderRole: props.folderRole }),
			...(props.sortOrder === 'oldest' ? { sortOrder: 'oldest' as const } : {}),
		});
		bulk.selectAllMatchingIds(result.ids, result.capped);
	} finally {
		loadingAllMatching.value = false;
	}
}

defineExpose({ selectAllMatching });
</script>

<template>
	<div
		v-if="pageFullySelected"
		class="w-full px-3 pb-2 text-xs text-text-secondary flex flex-wrap items-baseline gap-x-2 gap-y-0.5"
		role="status"
	>
		<template v-if="bulk.selectAllMatching.value.active">
			<span>{{
				t(
					'components.postbox.postboxBulkSelectAllRow.allMatchingSelected',
					{ count: bulk.count.value },
					bulk.count.value
				)
			}}</span>
			<span v-if="bulk.selectAllMatching.value.capped" class="text-text-tertiary">{{
				t('components.postbox.postboxBulkSelectAllRow.allMatchingCapped', {
					count: bulk.count.value,
				})
			}}</span>
			<button type="button" class="text-brand hover:underline whitespace-nowrap" @click="bulk.clear()">
				{{ t('components.postbox.postboxBulkSelectAllRow.clearSelection') }}
			</button>
		</template>
		<template v-else>
			<span>{{
				t(
					'components.postbox.postboxBulkSelectAllRow.pageSelected',
					{ count: bulk.count.value },
					bulk.count.value
				)
			}}</span>
			<button
				v-if="canSelectAllMatching"
				type="button"
				class="text-brand hover:underline disabled:opacity-50 whitespace-nowrap"
				:disabled="loadingAllMatching"
				@click="selectAllMatching()"
			>
				{{
					loadingAllMatching
						? t('components.postbox.postboxBulkSelectAllRow.selectingAllMatching')
						: t('components.postbox.postboxBulkSelectAllRow.selectAllMatching')
				}}
			</button>
		</template>
	</div>
</template>
