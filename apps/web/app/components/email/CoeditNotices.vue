<script setup lang="ts">
/**
 * "Your change to this block was replaced" (co-editing, see
 * docs/adr/0071-email-coediting.md). Floats over the editor when someone
 * else's edit landed on a block or field this tab had changed without either
 * of them seeing the other's edit (the edit lease normally prevents that).
 * "Put mine back" re-applies this tab's version as an ordinary, undoable
 * edit; for a template the replaced version is also in version history.
 */
import type { Id } from '@owlat/api/dataModel';
import type { CoeditNoticeView } from '~/composables/useEmailEditorCoedit';

const props = defineProps<{
	notices: CoeditNoticeView[];
	/** The email keeps version history (templates do). */
	hasVersionHistory?: boolean;
}>();

const emit = defineEmits<{
	restore: [noticeId: Id<'emailCoeditNotices'>];
	dismiss: [noticeId: Id<'emailCoeditNotices'>];
}>();

const { t } = useI18n();

const FIELD_KEYS: Record<string, string> = {
	name: 'components.email.coeditNotices.fields.name',
	subject: 'components.email.coeditNotices.fields.subject',
	plainTextOverride: 'components.email.coeditNotices.fields.plainText',
	attachments: 'components.email.coeditNotices.fields.attachments',
	showUnsubscribe: 'components.email.coeditNotices.fields.unsubscribe',
};

function message(notice: CoeditNoticeView): string {
	if (notice.kind === 'field' && notice.field && FIELD_KEYS[notice.field]) {
		return t('components.email.coeditNotices.fieldReplaced', {
			name: notice.replacedBy,
			field: t(FIELD_KEYS[notice.field]!),
		});
	}
	return t('components.email.coeditNotices.blockReplaced', { name: notice.replacedBy });
}

const shown = computed(() => props.notices.slice(0, 3));
</script>

<template>
	<div
		v-if="notices.length > 0"
		class="fixed bottom-4 left-1/2 z-40 flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2"
		role="status"
		data-testid="coedit-notices"
	>
		<div
			v-for="notice in shown"
			:key="notice.noticeId"
			class="flex items-start gap-3 rounded-lg border border-warning/30 bg-bg-elevated px-4 py-3 shadow-lg"
		>
			<Icon name="lucide:git-merge" class="mt-0.5 h-4 w-4 shrink-0 text-warning" />
			<div class="min-w-0 flex-1">
				<p class="text-sm text-text-primary">{{ message(notice) }}</p>
				<p v-if="hasVersionHistory" class="mt-0.5 text-xs text-text-secondary">
					{{ t('components.email.coeditNotices.inHistory') }}
				</p>
				<div class="mt-2 flex items-center gap-2">
					<UiButton variant="secondary" size="sm" @click="emit('restore', notice.noticeId)">
						{{ t('components.email.coeditNotices.restore') }}
					</UiButton>
					<UiButton variant="ghost" size="sm" @click="emit('dismiss', notice.noticeId)">
						{{ t('components.email.coeditNotices.dismiss') }}
					</UiButton>
				</div>
			</div>
		</div>
	</div>
</template>
