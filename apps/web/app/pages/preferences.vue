<script setup lang="ts">
useSeoMeta({
	title: 'Email Preferences \u2014 Owlat',
	description: 'Manage your email subscription topics and preferences.',
	ogTitle: 'Email Preferences \u2014 Owlat',
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
		error.value = 'Missing preference token. Please use the link from your email.';
		isLoading.value = false;
		return;
	}

	try {
		// Verify the token via the Convex HTTP endpoint (outcome mode: 200 either way)
		const verifyUrl = `${config.public.convexSiteUrl}/prefs/verify/${encodeURIComponent(token.value)}`;
		const response = await fetch(verifyUrl);
		const body = await response.json();

		if (!body.ok) {
			if (body.reason === 'expired') {
				error.value =
					'This preference link has expired. Please use a more recent email to manage your preferences.';
			} else {
				error.value = 'Invalid preference link. Please use the link from your email.';
			}
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
		error.value = 'Unable to verify your preference link. Please try again later.';
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

		successMessage.value = 'Your preferences have been saved successfully.';

		// Clear success message after 5 seconds
		setTimeout(() => {
			successMessage.value = null;
		}, 5000);
	} catch (err) {
		error.value =
			err instanceof Error ? err.message : 'Failed to save preferences. Please try again.';
	} finally {
		isSaving.value = false;
	}
}
</script>

<template>
	<div class="min-h-screen bg-bg-deep flex flex-col items-center justify-center px-4 py-8">
		<!-- Logo/Brand -->
		<div class="mb-8 text-center">
			<h1 class="font-display text-4xl text-text-primary">Owlat</h1>
			<p class="text-text-secondary mt-2">Email Preferences</p>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading" class="card w-full max-w-lg text-center py-12">
			<div class="flex flex-col items-center gap-4">
				<svg
					class="animate-spin h-8 w-8 text-brand"
					xmlns="http://www.w3.org/2000/svg"
					fill="none"
					viewBox="0 0 24 24"
				>
					<circle
						class="opacity-25"
						cx="12"
						cy="12"
						r="10"
						stroke="currentColor"
						stroke-width="4"
					/>
					<path
						class="opacity-75"
						fill="currentColor"
						d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
					/>
				</svg>
				<p class="text-text-secondary">Loading your preferences...</p>
			</div>
		</div>

		<!-- Error State -->
		<div v-else-if="error && !contactInfo" class="card w-full max-w-lg">
			<div class="text-center py-8">
				<div
					class="w-16 h-16 mx-auto mb-4 rounded-full bg-error-subtle flex items-center justify-center"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-8 w-8 text-error"
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
				<h2 class="text-lg font-semibold text-text-primary mb-2">Unable to Load Preferences</h2>
				<p class="text-text-secondary">{{ error }}</p>
			</div>
		</div>

		<!-- Preferences Form -->
		<div v-else-if="contactInfo" class="card w-full max-w-lg">
			<div class="p-6">
				<!-- Header -->
				<div class="text-center mb-6">
					<h2 class="text-xl font-semibold text-text-primary mb-2">
						Manage Your Email Preferences
					</h2>
					<p class="text-text-secondary">
						<template v-if="contactInfo.firstName"> Hi {{ contactInfo.firstName }}, </template>
						Update your email preferences for <strong>{{ contactInfo.teamName }}</strong
						>.
					</p>
					<p class="text-text-tertiary text-sm mt-1">
						{{ contactInfo.email }}
					</p>
				</div>

				<!-- Success Message -->
				<div
					v-if="successMessage"
					class="mb-4 p-3 rounded-lg bg-success-subtle text-success text-sm flex items-center gap-2"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-5 w-5"
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
					class="mb-4 p-3 rounded-lg bg-error-subtle text-error text-sm flex items-center gap-2"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						class="h-5 w-5"
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

				<!-- Global Subscription Toggle -->
				<div class="mb-6 flex items-center justify-between p-3 bg-bg-elevated rounded-lg">
					<div class="flex-1 min-w-0 mr-4">
						<p class="text-sm font-medium text-text-primary">Subscribed to emails</p>
						<p class="text-xs text-text-tertiary">
							Turn this off to unsubscribe from all topics at once.
						</p>
					</div>
					<UiSwitch
						:model-value="localSubscribed"
						label="Subscribed to all emails"
						@update:model-value="toggleGlobalSubscription"
					/>
				</div>

				<!-- Topics Section -->
				<div v-if="localTopics.length > 0" class="mb-6">
					<h3 class="text-sm font-medium text-text-primary mb-3">Topics</h3>
					<div class="space-y-3">
						<div
							v-for="list in localTopics"
							:key="list._id"
							class="flex items-center justify-between p-3 bg-bg-elevated rounded-lg"
						>
							<div class="flex-1 min-w-0 mr-4">
								<p class="text-sm font-medium text-text-primary truncate">{{ list.name }}</p>
								<p v-if="list.description" class="text-xs text-text-tertiary truncate">
									{{ list.description }}
								</p>
							</div>
							<UiSwitch
								:model-value="list.subscribed"
								:label="`Subscription to ${list.name}`"
								@update:model-value="toggleTopicSubscription(list._id)"
							/>
						</div>
					</div>
				</div>

				<!-- No Topics Message -->
				<div v-else class="mb-6 text-center py-4">
					<p class="text-text-tertiary text-sm">No topics available.</p>
				</div>

				<!-- Save Button -->
				<button
					type="button"
					class="btn btn-primary w-full h-12"
					:disabled="!hasChanges || isSaving"
					@click="savePreferences"
				>
					<span v-if="isSaving" class="flex items-center justify-center gap-2">
						<svg
							class="animate-spin h-5 w-5"
							xmlns="http://www.w3.org/2000/svg"
							fill="none"
							viewBox="0 0 24 24"
						>
							<circle
								class="opacity-25"
								cx="12"
								cy="12"
								r="10"
								stroke="currentColor"
								stroke-width="4"
							/>
							<path
								class="opacity-75"
								fill="currentColor"
								d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
							/>
						</svg>
						Saving...
					</span>
					<span v-else>
						{{ hasChanges ? 'Save Preferences' : 'No Changes to Save' }}
					</span>
				</button>

				<p class="text-text-tertiary text-xs mt-4 text-center">
					Transactional emails (like password resets) may still be sent regardless of these
					preferences.
				</p>
			</div>
		</div>

		<!-- Footer -->
		<p class="mt-8 text-text-tertiary text-sm">
			Powered by <span class="font-display">Owlat</span>
		</p>
	</div>
</template>
