<script setup lang="ts">
import { fetchPublicToken } from '~/lib/publicTokenClient';
import { useRecipientTokenFlow } from '~/composables/useRecipientTokenFlow';
import RecipientStateCard from '~/components/recipient/RecipientStateCard.vue';

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

const { senderName, contactEmail, logo } = useRecipientSender();

interface Topic {
	_id: string;
	name: string;
	description?: string;
	subscribed: boolean;
}

interface PreferencesContact {
	email: string;
	firstName?: string;
	teamName: string;
	topics: Topic[];
}

const {
	state,
	data: contact,
	errorKey,
	isProcessing: isSaving,
	run,
} = useRecipientTokenFlow({
	verify: (token) => fetchPublicToken<PreferencesContact>('prefs/verify', token),
	missingTokenKey: 'recipient.preferences.errors.missingToken',
	reasons: { expired: 'recipient.preferences.errors.expired' },
	fallbackKey: 'recipient.preferences.errors.invalid',
	unreachableKey: 'recipient.preferences.errors.verifyFailed',
});

/** "Subscribed" globally means opted in to at least one topic. */
function anySubscribed(topics: Topic[]): boolean {
	return topics.some((topic) => topic.subscribed);
}

const successMessage = ref<string | null>(null);
/** Hides the "saved" banner again; cleared on unmount so it never fires late. */
let successTimer: ReturnType<typeof setTimeout> | undefined;

function clearSuccessTimer(): void {
	if (successTimer !== undefined) clearTimeout(successTimer);
	successTimer = undefined;
}

onBeforeUnmount(clearSuccessTimer);

// What was last loaded or saved, and the draft the switches edit.
const saved = ref<{ subscribed: boolean; topics: Topic[] }>({ subscribed: true, topics: [] });
const localSubscribed = ref(true);
const localTopics = ref<Topic[]>([]);

function resetBaseline(subscribed: boolean, topics: Topic[]): void {
	saved.value = { subscribed, topics: topics.map((topic) => ({ ...topic })) };
	localSubscribed.value = subscribed;
	localTopics.value = topics.map((topic) => ({ ...topic }));
}

watch(contact, (loaded) => {
	if (loaded) resetBaseline(anySubscribed(loaded.topics), loaded.topics);
});

/** The topics whose switch differs from what was saved. */
const changedTopics = computed(() =>
	localTopics.value.filter((topic) => {
		const original = saved.value.topics.find((entry) => entry._id === topic._id);
		return original !== undefined && original.subscribed !== topic.subscribed;
	})
);

const hasChanges = computed(
	() =>
		contact.value !== null &&
		(localSubscribed.value !== saved.value.subscribed || changedTopics.value.length > 0)
);

// Toggle topic subscription
function toggleTopicSubscription(listId: string) {
	const list = localTopics.value.find((l) => l._id === listId);
	if (list) {
		list.subscribed = !list.subscribed;
	}
	// Keep the global switch in sync with the per-topic state: subscribed to
	// any topic ⇒ globally subscribed.
	localSubscribed.value = anySubscribed(localTopics.value);
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

// Save preferences. A failure stays on the form, next to the switches.
async function savePreferences() {
	if (!contact.value) return;
	clearSuccessTimer();
	successMessage.value = null;

	const topicUpdates = changedTopics.value.map((topic) => ({
		topicId: topic._id,
		subscribed: topic.subscribed,
	}));
	const nextSubscribed = localSubscribed.value;
	const nextTopics = localTopics.value.map((topic) => ({ ...topic }));
	const globalUnsubscribe = nextSubscribed !== saved.value.subscribed ? !nextSubscribed : undefined;

	const result = await run(
		(token) =>
			fetchPublicToken('prefs/update', token, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					globalUnsubscribe,
					topicUpdates: topicUpdates.length > 0 ? topicUpdates : undefined,
				}),
			}),
		{ fallbackKey: 'recipient.preferences.errors.saveFailed', inline: true }
	);
	if (!result?.ok) return;

	// What was just saved is the new baseline.
	resetBaseline(nextSubscribed, nextTopics);
	successMessage.value = t('recipient.preferences.saved');
	successTimer = setTimeout(() => {
		successTimer = undefined;
		successMessage.value = null;
	}, 5000);
}
</script>

<template>
	<!-- Recipient-facing page: opened from an email client, mostly on a phone.
	     Single column, dvh (mobile browser chrome collapses the visual viewport)
	     and safe-area padding so nothing sits under a notch or home indicator. -->
	<div
		class="flex min-h-dvh flex-col items-center justify-center gap-8 bg-bg-deep px-5 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))] text-text-primary"
	>
		<!-- The sender, not Owlat: the recipient knows who emailed them. -->
		<RecipientHeader
			:name="senderName"
			:logo="logo"
			:purpose="t('recipient.shared.emailPreferences')"
		/>

		<RecipientStateCard
			v-if="state === 'loading'"
			variant="loading"
			width="lg"
			:message="t('recipient.preferences.loading')"
		/>

		<RecipientStateCard
			v-else-if="state === 'error'"
			variant="error"
			width="lg"
			:heading="t('recipient.preferences.errorHeading')"
			:message="errorKey ? t(errorKey) : undefined"
		>
			<RecipientContactHint :email="contactEmail" keypath="recipient.shared.contactToOptOut" />
		</RecipientStateCard>

		<!-- Preferences Form -->
		<div v-else-if="contact" class="card w-full max-w-lg">
			<!-- Header -->
			<div class="mb-6 text-center">
				<h2 class="mb-2 text-xl font-semibold text-text-primary">
					{{ t('recipient.preferences.heading') }}
				</h2>
				<!-- break-words: contact emails and org names are unbounded strings and
				     this card is read at 320px. -->
				<p class="break-words text-text-secondary">
					<template v-if="contact.firstName">
						{{ t('recipient.preferences.greeting', { name: contact.firstName }) }}
					</template>
					<I18nT keypath="recipient.preferences.intro" tag="span" scope="global">
						<template #organization
							><strong>{{ contact.teamName }}</strong></template
						>
					</I18nT>
				</p>
				<p class="mt-1 text-sm break-words text-text-tertiary">
					{{ contact.email }}
				</p>
			</div>

			<!-- Success Message -->
			<div
				v-if="successMessage"
				role="status"
				class="mb-4 flex items-start gap-2 rounded-lg bg-success-subtle p-3 text-sm text-success"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-5 w-5 shrink-0"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					aria-hidden="true"
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
				v-if="errorKey"
				role="alert"
				class="mb-4 flex items-start gap-2 rounded-lg bg-error-subtle p-3 text-sm text-error"
			>
				<svg
					xmlns="http://www.w3.org/2000/svg"
					class="h-5 w-5 shrink-0"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
					aria-hidden="true"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
					/>
				</svg>
				{{ t(errorKey) }}
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
					{{ hasChanges ? t('recipient.preferences.save') : t('recipient.preferences.noChanges') }}
				</span>
			</UiButton>

			<p class="mt-4 text-center text-xs text-text-tertiary">
				{{ t('recipient.preferences.footnote') }}
			</p>
		</div>

		<RecipientFooter />
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
