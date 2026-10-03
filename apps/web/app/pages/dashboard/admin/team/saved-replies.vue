<script setup lang="ts">
/**
 * Admin → Team → Saved replies: the organization's shared replies, in every
 * member's composer picker unless limited to some team inboxes. Owners and
 * admins add and change them; the backend holds that floor on every write.
 */
import { api } from '@owlat/api';
import SavedReplyLibrary from '~/components/savedReply/SavedReplyLibrary.vue';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.team.savedReplies.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
	requiresAnyFeature: ['postbox', 'mail.external', 'inbox'],
});

const { showAdminGate, isAdmin } = usePermissions();
const { isEnabled } = useFeatureFlag();

// Team inboxes exist only with the Postbox; a Team-inbox-only instance has none
// to limit a reply to.
const { data: inboxes } = useConvexQuery(api.mail.mailboxMembers.listShared, () =>
	isAdmin.value && (isEnabled('postbox') || isEnabled('mail.external')) ? {} : 'skip'
);
const teamInboxes = computed(() =>
	(inboxes.value ?? []).map((inbox) => ({
		_id: inbox._id,
		label: inbox.displayName ? `${inbox.displayName} (${inbox.address})` : inbox.address,
	}))
);
</script>

<template>
	<div class="space-y-6">
		<UiPageHeader :title="t('dashboard.admin.team.savedReplies.title')">
			<template #description>
				<I18nT
					keypath="dashboard.admin.team.savedReplies.intro"
					tag="p"
					class="text-text-secondary"
					scope="global"
				>
					<template #triggerKey><code>;</code></template>
				</I18nT>
			</template>
		</UiPageHeader>

		<div
			v-if="showAdminGate"
			class="card flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:lock" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.admin.team.savedReplies.adminGate.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.admin.team.savedReplies.adminGate.description') }}
			</p>
		</div>
		<SavedReplyLibrary v-else scope="shared" :team-inboxes="teamInboxes" />
	</div>
</template>
