<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.label.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const labelId = useRouteId<'mailLabels'>('labelId');
const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);

// Server-side label view: `listByLabel` scans the mailbox's newest messages
// server-side and returns only rows carrying this label. Replaces the P3
// stopgap that fetched up to 500 recent mailbox messages to the browser and
// filtered labelIds client-side.
//
// The view is bounded, not cursor-paged: the backend scans its fixed window
// (LABEL_SCAN_WINDOW) and slices it to `limit`, so a single fetch at the
// display cap gets everything the view can reach. When matches overflow even
// that slice (`hasMore`), the honest cap note renders — there is no deeper
// page to load, by design, until label membership gets a real index.
const { data: labelData, isLoading, error } = useConvexQuery(
	api.mail.mailbox.queries.listByLabel,
	() =>
		mailboxId.value ? { mailboxId: mailboxId.value, labelId: labelId.value, limit: 500 } : 'skip',
	{ keepPreviousData: true }
);
const labelMessages = computed(() => labelData.value?.messages ?? []);
/** Matches exist beyond the display slice (within the backend's scan window). */
const overCap = computed(() => labelData.value?.hasMore ?? false);
</script>

<template>
	<div class="flex h-[calc(100vh-4rem)]">
		<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
			<div class="flex w-full">
				<aside
					class="w-full lg:w-96 lg:flex-shrink-0 border-r border-border-subtle flex flex-col bg-bg-surface"
				>
					<header class="border-b border-border-subtle px-4 py-3">
						<h2 class="text-sm font-semibold text-text-primary">
							{{ t('dashboard.postbox.label.detail.heading') }}
						</h2>
					</header>
					<PostboxQuickActionsBar :mailbox-id="mailboxId!" />
					<UiErrorAlert
						v-if="error"
						:message="t('dashboard.postbox.label.detail.loadError')"
						class="m-3"
					/>
					<p v-if="overCap" class="px-4 py-2 text-xs text-text-tertiary" role="status">
						{{ t('dashboard.postbox.label.detail.capNote', { count: 500 }, 500) }}
					</p>
					<div class="flex-1 overflow-auto">
						<PostboxThreadList
							:mailbox-id="mailboxId!"
							:messages="labelMessages"
							:loading="isLoading"
							folder-role="inbox"
							empty-context="label"
						/>
					</div>
				</aside>
				<!-- The list is the whole screen below lg, so the placeholder pane
				     (which has nothing to select into on a phone) drops out. -->
				<section class="flex-1 hidden lg:flex items-center justify-center text-text-secondary">
					{{ t('dashboard.postbox.label.detail.selectMessage') }}
				</section>
			</div>
		</PostboxMailboxGuard>
		<PostboxComposerStack />
		<PostboxShortcutHelp />
	</div>
</template>
