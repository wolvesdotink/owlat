<script setup lang="ts">
import { InboxIcon } from '@coolicons/vue';
import { adminEntryById } from '~/lib/adminSettingsRegistry';
import { isFeatureReachable } from '~/lib/routeFeatureGates';

/**
 * The Workbench with no inbox to work from. It offers a way to add one only
 * while the feature gate lets that page open; with mail switched off the link
 * would bounce straight back here, so the empty state says mail is off
 * instead, and someone who may change features (the Features page asks for the
 * admin role) gets the way there.
 *
 * Only an admin goes to the add-account page: creating a hosted mailbox needs
 * `organization:manage`, so a member would get a form the server refuses. A
 * member goes where the Postbox guard sends them: the connect wizard while
 * external accounts are on, otherwise the guard itself, which asks an admin.
 */
const ADD_ACCOUNT_PATH = '/dashboard/preferences/add-account';
const CONNECT_PATH = '/dashboard/postbox/migrate';
const POSTBOX_PATH = '/dashboard/postbox';

const { t } = useI18n();
const { isEnabled } = useFeatureFlag();
const { isAdmin } = usePermissions();

const canAddAccount = computed(() => isFeatureReachable(ADD_ACCOUNT_PATH, isEnabled));
const addAction = computed(() => {
	if (isAdmin.value) return { to: ADD_ACCOUNT_PATH, label: 'dashboard.today.noInbox.cta' };
	if (isEnabled('mail.external'))
		return { to: CONNECT_PATH, label: 'dashboard.today.noInbox.ctaMember' };
	return { to: POSTBOX_PATH, label: 'dashboard.today.noInbox.ctaAsk' };
});
const featuresPath = computed(() => (isAdmin.value ? adminEntryById('features')?.path : null));
</script>

<template>
	<div
		class="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-border-subtle px-6 py-8"
	>
		<InboxIcon class="size-6 text-text-tertiary" />
		<div v-if="canAddAccount">
			<h2 class="text-base font-medium text-text-primary">
				{{ t('dashboard.today.noInbox.title') }}
			</h2>
			<p class="mt-1 max-w-lg text-sm text-text-secondary">
				{{ t('dashboard.today.noInbox.body') }}
			</p>
		</div>
		<div v-else>
			<h2 class="text-base font-medium text-text-primary">
				{{ t('dashboard.today.noInbox.mailOff.title') }}
			</h2>
			<p class="mt-1 max-w-lg text-sm text-text-secondary">
				{{
					featuresPath
						? t('dashboard.today.noInbox.mailOff.bodyAdmin')
						: t('dashboard.today.noInbox.mailOff.bodyMember')
				}}
			</p>
		</div>
		<UiButton v-if="canAddAccount" :to="addAction.to" size="sm">
			{{ t(addAction.label) }}
		</UiButton>
		<UiButton v-else-if="featuresPath" :to="featuresPath" size="sm" variant="outline">
			{{ t('dashboard.today.openFeatures') }}
		</UiButton>
	</div>
</template>
