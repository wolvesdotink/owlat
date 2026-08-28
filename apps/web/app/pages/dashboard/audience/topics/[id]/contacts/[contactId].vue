<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.audience.topics.detail.contacts.detail.pageTitle') });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
});

const router = useRouter();

// Breadcrumbs
const { setDynamicBreadcrumbs, clearDynamicBreadcrumbs } = useBreadcrumbs();

// Get IDs from route
const topicId = useRouteId<'topics'>();
const contactId = useRouteId<'contacts'>('contactId');

// Fetch contact in topic details
const { data: details, isLoading } = useConvexQuery(
	api.topics.topics.getContactInTopicDetails,
	() => ({
		topicId: topicId.value,
		contactId: contactId.value,
	})
);

// Update breadcrumbs when data is loaded
watch(
	details,
	(data) => {
		if (data) {
			const contactDisplayName =
				data.contact.firstName || data.contact.lastName
					? `${data.contact.firstName || ''} ${data.contact.lastName || ''}`.trim()
					: (data.contact.email ?? '');
			setDynamicBreadcrumbs([
				{
					label: t('dashboard.audience.topics.detail.contacts.detail.breadcrumbs.audience'),
					href: '/dashboard/audience',
				},
				{
					label: t('dashboard.audience.topics.detail.contacts.detail.breadcrumbs.topics'),
					href: '/dashboard/audience/topics',
				},
				{ label: data.topic.name, href: `/dashboard/audience/topics/${topicId.value}` },
				{ label: contactDisplayName },
			]);
		}
	},
	{ immediate: true }
);

// Clear dynamic breadcrumbs on unmount
onUnmounted(() => {
	clearDynamicBreadcrumbs();
});

// Mutations
const { run: removeContact } = useBackendOperation(api.topics.topics.removeContact, {
	label: () => t('dashboard.audience.topics.detail.contacts.detail.operations.removeContact'),
});

// Remove modal state
const isRemoveModalOpen = ref(false);
const isRemoving = ref(false);

// Toast notifications (global)
const { showToast } = useToast();

// Email status helpers
const getEmailStatusLabel = (status: string) => {
	switch (status) {
		case 'sent':
			return t('dashboard.audience.topics.detail.contacts.detail.emailStatus.sent');
		case 'delivered':
			return t('dashboard.audience.topics.detail.contacts.detail.emailStatus.delivered');
		case 'opened':
			return t('dashboard.audience.topics.detail.contacts.detail.emailStatus.opened');
		case 'clicked':
			return t('dashboard.audience.topics.detail.contacts.detail.emailStatus.clicked');
		case 'bounced':
			return t('dashboard.audience.topics.detail.contacts.detail.emailStatus.bounced');
		case 'complained':
			return t('dashboard.audience.topics.detail.contacts.detail.emailStatus.complained');
		case 'queued':
			return t('dashboard.audience.topics.detail.contacts.detail.emailStatus.queued');
		default:
			return status;
	}
};

const getEmailStatusColor = (status: string) => {
	switch (status) {
		case 'clicked':
			return 'bg-brand/10 text-brand';
		case 'opened':
			return 'bg-success-subtle text-success';
		case 'delivered':
		case 'sent':
			return 'bg-bg-surface text-text-secondary';
		case 'bounced':
		case 'complained':
			return 'bg-error-subtle text-error';
		case 'queued':
			return 'bg-warning-subtle text-warning';
		default:
			return 'bg-bg-surface text-text-tertiary';
	}
};

const getEmailStatusIcon = (status: string): string => {
	switch (status) {
		case 'clicked':
			return 'lucide:mouse-pointer';
		case 'opened':
			return 'lucide:eye';
		case 'delivered':
		case 'sent':
			return 'lucide:send';
		case 'bounced':
		case 'complained':
			return 'lucide:alert-triangle';
		case 'queued':
			return 'lucide:clock';
		default:
			return 'lucide:send';
	}
};

// Handle remove from topic
const handleRemove = async () => {
	isRemoving.value = true;

	const result = await removeContact({
		topicId: topicId.value,
		contactId: contactId.value,
	});
	if (!result.ok) {
		isRemoving.value = false;
		isRemoveModalOpen.value = false;
		return;
	}
	showToast(t('dashboard.audience.topics.detail.contacts.detail.toasts.removed'));
	// Navigate back to topic detail page
	router.push(`/dashboard/audience/topics/${topicId.value}`);
};

// Get contact display name
const contactName = computed(() => {
	if (!details.value) return '';
	const { firstName, lastName, email } = details.value.contact;
	if (firstName || lastName) {
		return `${firstName || ''} ${lastName || ''}`.trim();
	}
	return email;
});

// Get initials for avatar
const contactInitials = computed(() => {
	if (!details.value) return '';
	const { firstName, lastName, email } = details.value.contact;
	return personInitials(firstName, lastName, email);
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Loading State -->
		<div v-if="isLoading && !details" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('dashboard.audience.topics.detail.contacts.detail.loading') }}
				</p>
			</div>
		</div>

		<!-- Not Found State -->
		<div
			v-else-if="!isLoading && !details"
			class="flex flex-col items-center justify-center py-16 text-center px-6"
		>
			<UiIconBox icon="lucide:user" size="xl" variant="surface" rounded="full" class="mb-4" />
			<p class="text-text-secondary font-medium">
				{{ t('dashboard.audience.topics.detail.contacts.detail.notFound.title') }}
			</p>
			<p class="text-sm text-text-tertiary mt-1 max-w-sm">
				{{ t('dashboard.audience.topics.detail.contacts.detail.notFound.body') }}
			</p>
			<UiButton :to="`/dashboard/audience/topics/${topicId}`" class="mt-6">
				{{ t('dashboard.audience.topics.detail.contacts.detail.notFound.action') }}
			</UiButton>
		</div>

		<!-- Main Content -->
		<template v-else-if="details">
			<!-- Back link -->
			<NuxtLink
				:to="`/dashboard/audience/topics/${topicId}`"
				class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				{{
					t('dashboard.audience.topics.detail.contacts.detail.backToTopic', {
						topic: details.topic.name,
					})
				}}
			</NuxtLink>

			<!-- Two column layout -->
			<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
				<!-- Main Content (2/3) -->
				<div class="lg:col-span-2 space-y-6">
					<!-- Contact Header Card -->
					<div class="card">
						<div class="flex items-start gap-4">
							<div
								class="w-14 h-14 rounded-full bg-brand/10 flex items-center justify-center flex-shrink-0"
							>
								<span class="text-lg font-semibold text-brand">{{ contactInitials }}</span>
							</div>
							<div class="flex-1 min-w-0">
								<h1 class="text-xl font-semibold text-text-primary">
									{{ contactName }}
								</h1>
								<p class="text-text-secondary mt-0.5">{{ details.contact.email }}</p>
								<NuxtLink
									:to="`/dashboard/audience/contacts/${contactId}`"
									class="inline-flex items-center gap-1.5 text-sm text-brand hover:text-brand/80 transition-colors mt-2"
								>
									{{ t('dashboard.audience.topics.detail.contacts.detail.viewFullProfileLink') }}
									<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
								</NuxtLink>
							</div>
						</div>
					</div>

					<!-- Topic Membership Card -->
					<div class="card">
						<div class="flex items-center gap-2 mb-4">
							<Icon name="lucide:list" class="w-5 h-5 text-text-tertiary" />
							<h2 class="text-lg font-medium text-text-primary">
								{{ t('dashboard.audience.topics.detail.contacts.detail.membership.title') }}
							</h2>
						</div>

						<div class="space-y-4">
							<!-- Added Date -->
							<div class="flex items-center justify-between py-2 border-b border-border-subtle">
								<span class="text-text-secondary">{{
									t('dashboard.audience.topics.detail.contacts.detail.membership.addedAt')
								}}</span>
								<div class="flex items-center gap-2 text-text-primary">
									<Icon name="lucide:calendar" class="w-4 h-4 text-text-tertiary" />
									{{ formatDate(details.membership.addedAt) }}
								</div>
							</div>
						</div>
					</div>

					<!-- Email History Card -->
					<div class="card">
						<div class="flex items-center gap-2 mb-4">
							<Icon name="lucide:mail" class="w-5 h-5 text-text-tertiary" />
							<h2 class="text-lg font-medium text-text-primary">
								{{ t('dashboard.audience.topics.detail.contacts.detail.emailHistory.title') }}
							</h2>
							<span class="text-sm text-text-tertiary">
								{{ t('dashboard.audience.topics.detail.contacts.detail.emailHistory.scope') }}
							</span>
						</div>

						<!-- Empty State -->
						<div
							v-if="details.emailHistory.length === 0"
							class="flex flex-col items-center justify-center py-8 text-center"
						>
							<UiIconBox
								icon="lucide:mail"
								size="lg"
								variant="surface"
								rounded="full"
								class="mb-3"
							/>
							<p class="text-text-secondary text-sm">
								{{ t('dashboard.audience.topics.detail.contacts.detail.emailHistory.emptyTitle') }}
							</p>
							<p class="text-text-tertiary text-sm mt-1">
								{{ t('dashboard.audience.topics.detail.contacts.detail.emailHistory.emptyBody') }}
							</p>
						</div>

						<!-- Email History Table -->
						<div v-else class="overflow-x-auto -mx-6">
							<table class="w-full min-w-[600px]">
								<thead>
									<tr class="border-b border-border-subtle">
										<th class="text-left px-6 py-3 text-sm font-medium text-text-secondary">
											{{
												t('dashboard.audience.topics.detail.contacts.detail.emailHistory.campaign')
											}}
										</th>
										<th class="text-left px-6 py-3 text-sm font-medium text-text-secondary">
											{{ t('dashboard.audience.topics.detail.contacts.detail.emailHistory.sent') }}
										</th>
										<th class="text-left px-6 py-3 text-sm font-medium text-text-secondary">
											{{ t('common.status') }}
										</th>
										<th class="text-center px-6 py-3 text-sm font-medium text-text-secondary">
											{{ t('dashboard.audience.topics.detail.contacts.detail.emailHistory.opens') }}
										</th>
										<th class="text-center px-6 py-3 text-sm font-medium text-text-secondary">
											{{
												t('dashboard.audience.topics.detail.contacts.detail.emailHistory.clicks')
											}}
										</th>
									</tr>
								</thead>
								<tbody>
									<tr
										v-for="email in details.emailHistory"
										:key="email.campaignId"
										class="border-b border-border-subtle last:border-b-0"
									>
										<td class="px-6 py-3">
											<div>
												<p class="text-text-primary text-sm font-medium">
													{{ email.campaignName }}
												</p>
												<p class="text-text-tertiary text-xs mt-0.5 truncate max-w-xs">
													{{ email.subject }}
												</p>
											</div>
										</td>
										<td class="px-6 py-3">
											<span class="text-text-secondary text-sm">{{
												formatDateTime(email.sentAt)
											}}</span>
										</td>
										<td class="px-6 py-3">
											<span
												:class="[
													'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium',
													getEmailStatusColor(email.status),
												]"
											>
												<Icon :name="getEmailStatusIcon(email.status)" class="w-3 h-3" />
												{{ getEmailStatusLabel(email.status) }}
											</span>
										</td>
										<td class="px-6 py-3 text-center">
											<span class="text-text-secondary text-sm">{{ email.openCount }}</span>
										</td>
										<td class="px-6 py-3 text-center">
											<span class="text-text-secondary text-sm">{{
												email.clickedLinks.length
											}}</span>
										</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>
				</div>

				<!-- Sidebar (1/3) -->
				<div class="space-y-6">
					<!-- Engagement Stats Card -->
					<div class="card">
						<div class="flex items-center gap-2 mb-4">
							<Icon name="lucide:bar-chart-3" class="w-5 h-5 text-text-tertiary" />
							<h2 class="text-lg font-medium text-text-primary">
								{{ t('dashboard.audience.topics.detail.contacts.detail.engagement.title') }}
							</h2>
						</div>

						<div class="space-y-4">
							<div class="flex items-center justify-between">
								<span class="text-text-secondary text-sm">{{
									t('dashboard.audience.topics.detail.contacts.detail.engagement.received')
								}}</span>
								<span class="text-text-primary font-medium">{{
									details.emailStats.totalSent
								}}</span>
							</div>

							<div class="flex items-center justify-between">
								<span class="text-text-secondary text-sm">{{
									t('dashboard.audience.topics.detail.contacts.detail.engagement.openRate')
								}}</span>
								<span class="text-text-primary font-medium"
									>{{ details.emailStats.openRate }}%</span
								>
							</div>

							<div class="flex items-center justify-between">
								<span class="text-text-secondary text-sm">{{
									t('dashboard.audience.topics.detail.contacts.detail.engagement.clickRate')
								}}</span>
								<span class="text-text-primary font-medium"
									>{{ details.emailStats.clickRate }}%</span
								>
							</div>

							<div
								v-if="details.emailStats.lastEngagement"
								class="pt-4 border-t border-border-subtle"
							>
								<span class="text-text-tertiary text-sm">{{
									t('dashboard.audience.topics.detail.contacts.detail.engagement.lastEngagement')
								}}</span>
								<p class="text-text-primary mt-1">
									{{ formatDate(details.emailStats.lastEngagement) }}
								</p>
							</div>
							<div v-else class="pt-4 border-t border-border-subtle">
								<span class="text-text-tertiary text-sm">{{
									t('dashboard.audience.topics.detail.contacts.detail.engagement.lastEngagement')
								}}</span>
								<p class="text-text-secondary mt-1">
									{{ t('dashboard.audience.topics.detail.contacts.detail.engagement.none') }}
								</p>
							</div>
						</div>
					</div>

					<!-- Actions Card -->
					<div class="card">
						<h2 class="text-lg font-medium text-text-primary mb-4">{{ t('common.actions') }}</h2>

						<div class="space-y-3">
							<UiButton
								variant="secondary"
								full-width
								:to="`/dashboard/audience/contacts/${contactId}`"
								class="gap-2"
							>
								<Icon name="lucide:user" class="w-4 h-4" />
								{{ t('dashboard.audience.topics.detail.contacts.detail.viewFullProfile') }}
							</UiButton>

							<UiButton
								full-width
								class="gap-2 text-error bg-error-subtle hover:bg-error/20 border-0"
								@click="isRemoveModalOpen = true"
							>
								<Icon name="lucide:trash-2" class="w-4 h-4" />
								{{ t('dashboard.audience.topics.detail.contacts.detail.removeFromTopic') }}
							</UiButton>
						</div>
					</div>
				</div>
			</div>
		</template>

		<!-- Remove Confirmation Modal -->
		<UiConfirmationDialog
			:open="isRemoveModalOpen"
			variant="danger"
			:title="t('dashboard.audience.topics.detail.contacts.detail.removeFromTopic')"
			:description="
				t('dashboard.audience.topics.detail.contacts.detail.removeDialog.description', {
					email: details?.contact.email ?? '',
					topic: details?.topic.name ?? '',
				})
			"
			:confirm-text="t('common.remove')"
			:is-loading="isRemoving"
			@update:open="
				(v: boolean) => {
					if (!v) isRemoveModalOpen = false;
				}
			"
			@confirm="handleRemove"
		/>
	</div>
</template>
