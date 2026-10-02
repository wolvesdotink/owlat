<script setup lang="ts">
/**
 * One scope's saved replies, managed: the list (most used first, with how
 * often and when each was last used), a form to add or change one, and a
 * confirmation before deleting. Preferences mounts it for personal replies, the
 * admin Team page for shared ones; there a member who is not an admin sees the
 * list read-only.
 */
import type { Id } from '@owlat/api/dataModel';
import { htmlToPlainText } from '@owlat/shared/html';
import {
	useSavedReplyLibrary,
	type SavedReplyDraft,
	type SavedReplyScope,
} from '~/composables/useSavedReplies';
import { formatRelativeTime } from '~/utils/formatters';
import { rankSnippets } from '~/utils/postboxSnippets';
import type { SnippetVariable } from '~/utils/postboxSnippetVariables';
import SavedReplyEditor from './SavedReplyEditor.vue';

const props = defineProps<{
	scope: SavedReplyScope;
	/** Shared replies only: the team inboxes one can be limited to. */
	teamInboxes?: { _id: Id<'mailboxes'>; label: string }[];
}>();

const { t } = useI18n();
const library = useSavedReplyLibrary(props.scope);
const { replies, canManage, isLoading, error, refetch } = library;

type Reply = (typeof replies.value)[number];

const ordered = computed(() => rankSnippets([...replies.value], ''));
const inboxLabels = computed(
	() => new Map((props.teamInboxes ?? []).map((inbox) => [inbox._id, inbox.label]))
);

function preview(reply: Reply): string {
	return htmlToPlainText(reply.bodyHtml).slice(0, 200);
}

function usage(reply: Reply): string {
	return reply.useCount > 0
		? t(
				'shared.savedReplies.library.used',
				{ count: reply.useCount, when: formatRelativeTime(reply.lastUsedAt) },
				reply.useCount
			)
		: t('shared.savedReplies.library.neverUsed');
}

function limitedTo(reply: Reply): string | null {
	if (reply.mailboxIds.length === 0) return null;
	const names = reply.mailboxIds.map(
		(id) => inboxLabels.value.get(id) ?? t('shared.savedReplies.library.unknownInbox')
	);
	return t('shared.savedReplies.library.limitedTo', { inboxes: names.join(', ') });
}

// The form: `null` closed, `'new'` a new reply, otherwise the reply being edited.
const editing = ref<'new' | Reply | null>(null);
const saving = ref(false);
const initial = computed<SavedReplyDraft | null>(() => {
	const reply = editing.value;
	if (!reply || reply === 'new') return null;
	return {
		name: reply.name,
		shortcut: reply.shortcut,
		bodyHtml: reply.bodyHtml,
		variables: (reply.variables ?? []) as SnippetVariable[],
		mailboxIds: reply.mailboxIds,
	};
});

async function save(draft: SavedReplyDraft) {
	const reply = editing.value;
	if (!reply) return;
	saving.value = true;
	try {
		const result =
			reply === 'new' ? await library.create(draft) : await library.update(reply._id, draft);
		if (result.ok) editing.value = null;
	} finally {
		saving.value = false;
	}
}

const toRemove = ref<Id<'mailSnippets'> | null>(null);
const removing = ref(false);
async function confirmRemove() {
	const id = toRemove.value;
	if (!id) return;
	removing.value = true;
	try {
		await library.remove(id);
	} finally {
		removing.value = false;
		toRemove.value = null;
	}
}
</script>

<template>
	<div class="space-y-6">
		<div v-if="canManage && !editing" class="flex justify-end">
			<UiButton type="button" data-testid="saved-reply-new" @click="editing = 'new'">
				<Icon name="lucide:plus" class="w-4 h-4 mr-1.5" />
				{{ t('shared.savedReplies.library.new') }}
			</UiButton>
		</div>

		<SavedReplyEditor
			v-if="editing"
			:key="editing === 'new' ? 'new' : editing._id"
			:initial="initial"
			:team-inboxes="scope === 'shared' ? (teamInboxes ?? []) : undefined"
			:saving="saving"
			@save="save"
			@cancel="editing = null"
		/>

		<section class="card !p-0">
			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon
					name="lucide:loader-2"
					class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary"
				/>
			</div>
			<!-- A failed read is not an empty list (#721). -->
			<UiQueryBoundary v-else-if="error" :error="error" @retry="refetch" />
			<div v-else-if="ordered.length === 0" class="p-8 text-center text-text-secondary">
				{{ t(`shared.savedReplies.library.empty.${scope}`) }}
			</div>
			<ul v-else class="divide-y divide-border-subtle" data-testid="saved-reply-list">
				<li v-for="reply in ordered" :key="reply._id" class="px-5 py-3 flex items-start gap-3">
					<div class="flex-1 min-w-0">
						<div class="flex flex-wrap items-center gap-2">
							<span class="font-medium">{{ reply.name }}</span>
							<span
								v-if="reply.shortcut"
								class="text-xs px-1.5 py-0.5 rounded bg-bg-surface text-text-tertiary font-mono"
								>;{{ reply.shortcut }}</span
							>
						</div>
						<p class="text-xs text-text-tertiary mt-1 line-clamp-2">{{ preview(reply) }}</p>
						<p class="text-2xs text-text-tertiary mt-1">
							{{ usage(reply) }}
							<template v-if="limitedTo(reply)"> · {{ limitedTo(reply) }}</template>
						</p>
					</div>
					<template v-if="canManage">
						<UiButton variant="ghost" type="button" @click="editing = reply">
							{{ t('common.edit') }}
						</UiButton>
						<UiButton
							variant="ghost"
							type="button"
							class="text-error"
							@click="toRemove = reply._id"
						>
							{{ t('common.delete') }}
						</UiButton>
					</template>
				</li>
			</ul>
		</section>

		<UiConfirmationDialog
			:open="!!toRemove"
			variant="danger"
			:title="t('shared.savedReplies.library.deleteTitle')"
			:description="t(`shared.savedReplies.library.deleteDescription.${scope}`)"
			:confirm-text="t('common.delete')"
			:is-loading="removing"
			@update:open="(v: boolean) => !v && (toRemove = null)"
			@confirm="confirmRemove"
		/>
	</div>
</template>
