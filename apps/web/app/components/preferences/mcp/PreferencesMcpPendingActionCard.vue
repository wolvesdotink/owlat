<script setup lang="ts">
import type { McpPendingAction } from '~/composables/useMcpPendingActions';

const props = defineProps<{ action: McpPendingAction; busy: boolean }>();

const emit = defineEmits<{ (e: 'approve'): void; (e: 'reject'): void }>();

const { t } = useI18n();
const { formatRelativeTime } = useFormat();

const KEY = 'components.preferences.mcpPendingActionCard';

const TITLE_KEYS = {
	create_draft: `${KEY}.titles.createDraft`,
	send_draft: `${KEY}.titles.sendDraft`,
	archive_thread: `${KEY}.titles.archiveThread`,
	move_thread: `${KEY}.titles.moveThread`,
	label_thread: `${KEY}.titles.labelThread`,
} as const;

const details = computed(() => props.action.details);
const title = computed(() => {
	const tool = props.action.tool;
	if (tool === 'label_thread' && 'isRemoval' in details.value && details.value.isRemoval) {
		return t(`${KEY}.titles.unlabelThread`, { client: props.action.clientLabel });
	}
	return t(TITLE_KEYS[tool], { client: props.action.clientLabel });
});

const isMessage = computed(
	() => props.action.tool === 'create_draft' || props.action.tool === 'send_draft'
);
const isDraftGone = computed(() => 'isDraftGone' in details.value && details.value.isDraftGone);

function list(addresses: string[] | undefined) {
	return addresses && addresses.length > 0 ? addresses.join(', ') : '';
}
</script>

<template>
	<article class="rounded-md border border-border-subtle bg-bg-elevated p-4 text-sm">
		<header class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
			<h3 class="font-medium">{{ title }}</h3>
			<span class="text-xs text-text-tertiary">
				{{ t(`${KEY}.asked`, { time: formatRelativeTime(action.createdAt) }) }}
			</span>
		</header>
		<p v-if="action.mailboxAddress" class="text-xs text-text-secondary mt-0.5 break-all">
			{{ action.mailboxAddress }}
		</p>

		<p v-if="isDraftGone" class="mt-3 text-text-secondary">{{ t(`${KEY}.draftGone`) }}</p>
		<dl v-else class="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
			<template v-if="isMessage">
				<dt class="text-text-tertiary">{{ t(`${KEY}.to`) }}</dt>
				<dd class="break-all">{{ 'to' in details ? list(details.to) : '' }}</dd>
				<template v-if="'cc' in details && list(details.cc)">
					<dt class="text-text-tertiary">{{ t(`${KEY}.cc`) }}</dt>
					<dd class="break-all">{{ list(details.cc) }}</dd>
				</template>
				<template v-if="'bcc' in details && list(details.bcc)">
					<dt class="text-text-tertiary">{{ t(`${KEY}.bcc`) }}</dt>
					<dd class="break-all">{{ list(details.bcc) }}</dd>
				</template>
				<dt class="text-text-tertiary">{{ t(`${KEY}.subject`) }}</dt>
				<dd class="break-words">
					{{ ('subject' in details && details.subject) || t(`${KEY}.noSubject`) }}
				</dd>
				<template v-if="'inReplyToSubject' in details && details.inReplyToSubject">
					<dt class="text-text-tertiary">{{ t(`${KEY}.inReplyTo`) }}</dt>
					<dd class="break-words">{{ details.inReplyToSubject }}</dd>
				</template>
			</template>
			<template v-else>
				<dt class="text-text-tertiary">{{ t(`${KEY}.conversation`) }}</dt>
				<dd class="break-words">
					{{ ('threadSubject' in details && details.threadSubject) || t(`${KEY}.noSubject`) }}
				</dd>
				<template v-if="'folderName' in details && details.folderName">
					<dt class="text-text-tertiary">{{ t(`${KEY}.folder`) }}</dt>
					<dd class="break-words">{{ details.folderName }}</dd>
				</template>
				<template v-if="'labelName' in details && details.labelName">
					<dt class="text-text-tertiary">{{ t(`${KEY}.label`) }}</dt>
					<dd class="break-words">{{ details.labelName }}</dd>
				</template>
			</template>
		</dl>
		<p
			v-if="isMessage && !isDraftGone && 'body' in details && details.body"
			class="mt-3 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border-subtle bg-bg-base p-3 text-text-secondary"
		>
			{{ details.body }}
		</p>

		<footer class="mt-4 flex items-center justify-end gap-2">
			<UiButton variant="ghost" type="button" :disabled="busy" @click="emit('reject')">
				{{ t(`${KEY}.reject`) }}
			</UiButton>
			<UiButton type="button" :disabled="busy || isDraftGone" @click="emit('approve')">
				{{ action.tool === 'send_draft' ? t(`${KEY}.approveSend`) : t(`${KEY}.approve`) }}
			</UiButton>
		</footer>
	</article>
</template>
