<script setup lang="ts">
/**
 * Preferences → Saved replies: the caller's personal replies (the path keeps
 * the feature's first name, "snippets"). Shared replies are managed by admins
 * on the Team page; both kinds show in every composer's picker.
 */
import SavedReplyLibrary from '~/components/savedReply/SavedReplyLibrary.vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.preferences.snippets.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external', 'inbox'],
});

const { isAdmin } = usePermissions();
</script>

<template>
	<div>
		<header class="mb-6 space-y-2">
			<I18nT
				keypath="dashboard.preferences.snippets.intro"
				tag="p"
				class="text-text-secondary"
				scope="global"
			>
				<template #triggerKey><code>;</code></template>
			</I18nT>
			<p v-if="isAdmin" class="text-sm text-text-tertiary">
				{{ t('dashboard.preferences.snippets.sharedHint') }}
				<NuxtLink
					to="/dashboard/admin/team/saved-replies"
					class="text-text-secondary underline hover:text-text-primary"
				>
					{{ t('dashboard.preferences.snippets.sharedLink') }}
				</NuxtLink>
			</p>
		</header>
		<SavedReplyLibrary scope="personal" />
	</div>
</template>
