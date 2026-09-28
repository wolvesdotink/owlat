<script setup lang="ts">
/**
 * "API usage" for one transactional email: ready-to-paste cURL, JavaScript and
 * Python calls against this deployment's send endpoint, each with a copy button.
 */
import {
	SNIPPET_LANGUAGES,
	useTransactionalSnippets,
} from '~/composables/useTransactionalSnippets';

const props = defineProps<{
	/** The email the snippets send; `null` keeps the dialog closed. */
	email: { name: string; slug: string } | null;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const { getCodeSnippet, copySnippet, copiedSnippet, resetCopied } = useTransactionalSnippets(
	() => props.email?.slug ?? null
);

// A fresh dialog never shows a "Copied!" left over from the previous email.
watch(
	() => props.email,
	() => resetCopied()
);

const onOpenChange = (open: boolean) => {
	if (!open) emit('close');
};
</script>

<template>
	<UiModal
		:open="email !== null"
		size="2xl"
		:title="t('dashboard.send.transactional.index.apiUsage.title')"
		@update:open="onOpenChange"
	>
		<p class="text-sm text-text-secondary mb-4">
			{{ t('dashboard.send.transactional.index.apiUsage.subtitle', { name: email?.name }) }}
		</p>

		<div class="space-y-4">
			<div v-for="language in SNIPPET_LANGUAGES" :key="language.value">
				<div class="flex items-center justify-between mb-2">
					<h3 class="text-sm font-medium text-text-primary">{{ language.label }}</h3>
					<button
						type="button"
						class="flex items-center gap-1.5 rounded text-xs text-text-secondary hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
						@click="copySnippet(language.value)"
					>
						<Icon
							v-if="copiedSnippet === language.value"
							name="lucide:check"
							class="w-3.5 h-3.5 text-success"
						/>
						<Icon v-else name="lucide:copy" class="w-3.5 h-3.5" />
						{{
							copiedSnippet === language.value
								? t('dashboard.send.transactional.index.apiUsage.copied')
								: t('common.copy')
						}}
					</button>
				</div>
				<pre
					class="p-4 rounded-lg bg-bg-deep text-text-secondary text-sm font-mono overflow-x-auto whitespace-pre-wrap"
					>{{ getCodeSnippet(language.value) }}</pre>
			</div>

			<div class="p-4 rounded-lg bg-warning/10 border border-warning/20">
				<I18nT
					keypath="dashboard.send.transactional.index.apiUsage.note"
					tag="p"
					class="text-sm text-warning"
					scope="global"
				>
					<template #label>
						<strong>{{ t('dashboard.send.transactional.index.apiUsage.noteLabel') }}</strong>
					</template>
					<template #placeholder>
						<code class="px-1 py-0.5 rounded bg-warning/20">YOUR_API_KEY</code>
					</template>
					<template #settings>
						<NuxtLink to="/dashboard/admin" class="underline hover:no-underline">{{
							t('common.settings')
						}}</NuxtLink>
					</template>
				</I18nT>
			</div>
		</div>

		<template #footer>
			<UiButton variant="secondary" @click="emit('close')">
				{{ t('common.close') }}
			</UiButton>
		</template>
	</UiModal>
</template>
