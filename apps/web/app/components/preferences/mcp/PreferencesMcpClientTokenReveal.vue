<script setup lang="ts">
import { CheckIcon, CopyIcon } from '@coolicons/vue';

const props = defineProps<{
	open: boolean;
	token: string | null;
	label: string | null;
	serverUrl: string;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
}>();

const { t } = useI18n();
const { copy, copiedKey } = useCopyToClipboard();

// The JSON shape Claude Desktop, Cursor and most MCP clients read for a remote
// server; Claude Code takes the same values on its command line.
const configJson = computed(() =>
	JSON.stringify(
		{
			mcpServers: {
				owlat: {
					type: 'http',
					url: props.serverUrl,
					headers: { Authorization: `Bearer ${props.token ?? ''}` },
				},
			},
		},
		null,
		2
	)
);
const claudeCodeCommand = computed(
	() =>
		`claude mcp add --transport http owlat ${props.serverUrl} --header "Authorization: Bearer ${props.token ?? ''}"`
);

const snippets = computed(() => [
	{
		key: 'mcp-token',
		title: t('components.preferences.mcpClientTokenReveal.token'),
		text: props.token ?? '',
	},
	{
		key: 'mcp-config',
		title: t('components.preferences.mcpClientTokenReveal.config'),
		text: configJson.value,
	},
	{
		key: 'mcp-command',
		title: t('components.preferences.mcpClientTokenReveal.command'),
		text: claudeCodeCommand.value,
	},
]);
</script>

<template>
	<UiModal
		:open="open && !!token"
		size="lg"
		:title="t('components.preferences.mcpClientTokenReveal.title', { name: label ?? '' })"
		@update:open="emit('update:open', $event)"
	>
		<div v-if="token">
			<p class="text-sm text-text-secondary">
				{{ t('components.preferences.mcpClientTokenReveal.body') }}
			</p>

			<div v-for="snippet in snippets" :key="snippet.key" class="mt-4">
				<div class="flex items-center justify-between mb-1">
					<h3 class="text-sm font-medium">{{ snippet.title }}</h3>
					<UiButton
						variant="ghost"
						size="sm"
						type="button"
						@click="copy(snippet.text, snippet.key)"
					>
						<component
							:is="copiedKey === snippet.key ? CheckIcon : CopyIcon"
							class="w-4 h-4 mr-1.5"
						/>
						{{ copiedKey === snippet.key ? t('common.copied') : t('common.copy') }}
					</UiButton>
				</div>
				<pre
					class="p-3 rounded border border-border-subtle bg-bg-base font-mono text-xs whitespace-pre-wrap break-all select-all"
					>{{ snippet.text }}</pre>
			</div>
		</div>
		<template #footer>
			<UiButton type="button" @click="emit('update:open', false)">{{
				t('components.preferences.mcpClientTokenReveal.saved')
			}}</UiButton>
		</template>
	</UiModal>
</template>
