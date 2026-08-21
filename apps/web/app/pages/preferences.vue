<script setup lang="ts">
const { t } = useI18n();

useSeoMeta({
	title: () => t('recipient.preferences.pageTitle'),
	description: () => t('recipient.preferences.metaDescription'),
	ogTitle: () => t('recipient.preferences.pageTitle'),
});

// Public preference center page - no auth middleware needed
definePageMeta({
	layout: false, // No dashboard layout, standalone page
});

const route = useRoute();
const config = useRuntimeConfig();

// Types
interface Topic {
	_id: string;
	name: string;
	description?: string;
	subscribed: boolean;
}

// State
const isLoading = ref(true);
const isSaving = ref(false);
const error = ref<string | null>(null);
const successMessage = ref<string | null>(null);
const contactInfo = ref<{
	email: string;
	firstName?: string;
	subscribed: boolean;
	teamName: string;
	topics: Topic[];
} | null>(null);

// Local state for tracking changes
const localSubscribed = ref(true);
const localTopics = ref<Topic[]>([]);

// Get the token from the URL
const token = computed(() => route.query['token'] as string | undefined);

// Check if there are unsaved changes
const hasChanges = computed(() => {
	if (!contactInfo.value) return false;

	// Check global subscription change
	if (localSubscribed.value !== contactInfo.value.subscribed) return true;

	// Check topic changes
	for (const list of localTopics.value) {
		const original = contactInfo.value.topics.find((l) => l._id === list._id);
		if (original && original.subscribed !== list.subscribed) return true;
	}

	return false;
});

// Verify the token on mount
onMounted(async () => {
	if (!token.value) {
		error.value = t('recipient.preferences.errors.missingToken');
		isLoading.value = false;
		return;
	}

	try {
		// Verify the token via the Convex HTTP endpoint (outcome mode: 200 either way)
		const verifyUrl = `${config.public.convexSiteUrl}/prefs/verify/${encodeURIComponent(token.value)}`;
		const response = await fetch(verifyUrl);
		const body = await response.json();

		if (!body.ok) {
			error.value =
				body.reason === 'expired'
					? t('recipient.preferences.errors.expired')
					: t('recipient.preferences.errors.invalid');
			isLoading.value = false;
			return;
		}

		const { data } = body;
		// "Subscribed" globally means the contact is opted in to at least one
		// topic. Flipping this off issues a one-click unsubscribe-from-all.
		const subscribed = data.topics.some((list: Topic) => list.subscribed);
		contactInfo.value = {
			email: data.email,
			firstName: data.firstName,
			subscribed,
			teamName: data.teamName,
			topics: data.topics,
		};

		// Initialize local state
		localSubscribed.value = subscribed;
		localTopics.value = data.topics.map((list: Topic) => ({ ...list }));
	} catch (err) {
		error.value = t('recipient.preferences.errors.verifyFailed');
	} finally {
		isLoading.value = false;
	}
});

// Toggle topic subscription
function toggleTopicSubscription(listId: string) {
	const list = localTopics.value.find((l) => l._id === listId);
	if (list) {
		list.subscribed = !list.subscribed;
	}
	// Keep the global switch in sync with the per-topic state: subscribed to
	// any topic ⇒ globally subscribed.
	localSubscribed.value = localTopics.value.some((l) => l.subscribed);
}

// Handle global unsubscribe toggle. Turning it off is a one-click
// "unsubscribe from everything" — reflect that by clearing every per-topic
// toggle so the UI matches what will be saved. Turning it back on does NOT
// auto-resubscribe; the contact re-opts in per topic.
function toggleGlobalSubscription() {
	localSubscribed.value = !localSubscribed.value;
	if (!localSubscribed.value) {
		for (const list of localTopics.value) {
			list.subscribed = false;
		}
	}
}

// Save preferences
async function savePreferences() {
	if (!token.value || !contactInfo.value) return;

	isSaving.value = true;
	error.value = null;
	successMessage.value = null;

	try {
		// Prepare topic updates (only changed ones)
		const topicUpdates = localTopics.value
			.filter((list) => {
				const original = contactInfo.value!.topics.find((l) => l._id === list._id);
				return original && original.subscribed !== list.subscribed;
			})
			.map((list) => ({
				topicId: list._id,
				subscribed: list.subscribed,
			}));

		// Determine if global subscription changed
		const globalUnsubscribe =
			localSubscribed.value !== contactInfo.value.subscribed ? !localSubscribed.value : undefined;

		const updateUrl = `${config.public.convexSiteUrl}/prefs/update/${encodeURIComponent(token.value)}`;
		const response = await fetch(updateUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				globalUnsubscribe,
				topicUpdates: topicUpdates.length > 0 ? topicUpdates : undefined,
			}),
		});

		const body = await response.json();

		if (!response.ok || !body.ok) {
			throw new Error(body.error?.message || 'Failed to update preferences');
		}

		// Update the original state to match saved state
		contactInfo.value = {
			...contactInfo.value,
			subscribed: localSubscribed.value,
			topics: localTopics.value.map((list) => ({ ...list })),
		};

		successMessage.value = t('recipient.preferences.saved');

		// Clear success message after 5 seconds
		setTimeout(() => {
			successMessage.value = null;
		}, 5000);
	} catch (err) {
		error.value =
			err instanceof Error ? err.message : t('recipient.preferences.errors.saveFailed');
	} finally {
		isSaving.value = false;
	}
}
</script>

<template>
	<!-- Recipient-facing page: opened from an email client, mostly on a phone.
	     Single column, dvh (mobile browser chrome collapses the visual viewport)
	     and safe-area padding so nothing sits under a notch or home indicator. -->
	<div
		class="flex min-h-dvh flex-col items-center justify-center gap-8 bg-bg-deep px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-text-primary"
	>
		<!-- Logo/Brand -->
		<header class="text-center">
			<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
			<p class="mt-2 text-text-secondary">{{ t('recipient.shared.emailPreferences') }}</p>
		</header>

		<!-- Loading State -->
		<div v-if="isLoading" class="card w-full max-w-lg py-8 text-center">
			<div class="flex flex-col items-center gap-4">
				<UiSpinner size="lg" />
				<p class="text-text-secondary">{{ t('recipient.preferences.loading') }}</p>
			</div>
		</div>

		<!-- Error State -->
		<div v-else-if="error && !contactInfo" class="card w-full max-w-lg">
			<div class="py-2 text-center sm:py-4">
				<div
					class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-subtle sm:h-16 sm:w-16"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-7 w-7 text-error sm:h-8 sm:w-8"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
						/>
					</svg>
				</div>
				<h2 class="mb-2 text-lg font-semibold text-text-primary">
					{{ t('recipient.preferences.errorHeading') }}
				</h2>
				<p class="text-text-secondary">{{ error }}</p>
			</div>
		</div>

		<!-- Preferences Form -->
		<div v-else-if="contactInfo" class="card w-full max-w-lg">
			<!-- Header -->
			<div class="mb-6 text-center">
				<h2 class="mb-2 text-xl font-semibold text-text-primary">
					{{ t('recipient.preferences.heading') }}
				</h2>
				<!-- break-words: contact emails and org names are unbounded strings and
				     this card is read at 320px. -->
				<p class="break-words text-text-secondary">
					<template v-if="contactInfo.firstName">
						{{ t('recipient.preferences.greeting', { name: contactInfo.firstName }) }}
					</template>
					<I18nT keypath="recipient.preferences.intro" tag="span" scope="global">
						<template #organization><strong>{{ contactInfo.teamName }}</strong></template>
					</I18nT>
				</p>
				<p class="mt-1 text-sm break-words text-text-tertiary">
					{{ contactInfo.email }}
				</p>
			</div>

			<!-- Success Message -->
			<div
				v-if="successMessage"
				class="mb-4 flex items-start gap-2 rounded-lg bg-success-subtle p-3 text-sm text-success"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-5 w-5 shrink-0"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M5 13l4 4L19 7"
					/>
				</svg>
				{{ successMessage }}
			</div>

			<!-- Error Message -->
			<div
				v-if="error && contactInfo"
				class="mb-4 flex items-start gap-2 rounded-lg bg-error-subtle p-3 text-sm text-error"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-5 w-5 shrink-0"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
					/>
				</svg>
				{{ error }}
			</div>

			<!-- Global Subscription Toggle.
			     bg-bg-surface, not bg-bg-elevated: the card is already surface-2, so
			     an elevated fill would be the exact same colour in both modes. -->
			<div
				class="pref-row mb-6 flex items-center justify-between gap-4 rounded-lg bg-bg-surface p-4"
			>
				<div class="min-w-0 flex-1">
					<p class="text-sm font-medium text-text-primary">
						{{ t('recipient.preferences.globalToggleLabel') }}
					</p>
					<p class="text-xs text-text-tertiary">
						{{ t('recipient.preferences.globalToggleHint') }}
					</p>
				</div>
				<UiSwitch
					:model-value="localSubscribed"
					:label="t('recipient.preferences.globalSwitchLabel')"
					@update:model-value="toggleGlobalSubscription"
				/>
			</div>

			<!-- Topics Section -->
			<div v-if="localTopics.length > 0" class="mb-6">
				<h3 class="mb-3 text-sm font-medium text-text-primary">
					{{ t('recipient.preferences.topicsHeading') }}
				</h3>
				<div class="space-y-3">
					<div
						v-for="list in localTopics"
						:key="list._id"
						class="pref-row flex items-center justify-between gap-4 rounded-lg bg-bg-surface p-4"
					>
						<div class="min-w-0 flex-1">
							<p class="text-sm font-medium break-words text-text-primary">{{ list.name }}</p>
							<p v-if="list.description" class="text-xs break-words text-text-tertiary">
								{{ list.description }}
							</p>
						</div>
						<UiSwitch
							:model-value="list.subscribed"
							:label="t('recipient.preferences.topicSwitchLabel', { topic: list.name })"
							@update:model-value="toggleTopicSubscription(list._id)"
						/>
					</div>
				</div>
			</div>

			<!-- No Topics Message -->
			<div v-else class="mb-6 py-4 text-center">
				<p class="text-sm text-text-tertiary">{{ t('recipient.preferences.noTopics') }}</p>
			</div>

			<!-- Save Button (h-12 clears the 44px touch target) -->
			<UiButton
				full-width
				type="button"
				class="h-12"
				:disabled="!hasChanges || isSaving"
				@click="savePreferences"
			>
				<span v-if="isSaving" class="flex items-center justify-center gap-2">
					<UiSpinner size="sm" tone="inverse" />
					{{ t('recipient.preferences.saving') }}
				</span>
				<span v-else>
					{{
						hasChanges ? t('recipient.preferences.save') : t('recipient.preferences.noChanges')
					}}
				</span>
			</UiButton>

			<p class="mt-4 text-center text-xs text-text-tertiary">
				{{ t('recipient.preferences.footnote') }}
			</p>
		</div>

		<!-- Footer -->
		<I18nT keypath="common.poweredBy" tag="p" scope="global" class="text-sm text-text-tertiary">
			<template #brand><span class="font-display">Owlat</span></template>
		</I18nT>
	</div>
</template>

<style scoped>
/* The switch track is 44x24 — wide enough to hit, too short. These rows are the
 * whole job of the page on a phone, so each switch gets a transparent 44px-tall
 * hit area without growing the control. The track is `position: relative`
 * (UiSwitch), so the pseudo-element anchors to it. */
.pref-row :deep(button[role='switch'])::after {
	content: '';
	position: absolute;
	inset: -10px -8px;
}
</style>
