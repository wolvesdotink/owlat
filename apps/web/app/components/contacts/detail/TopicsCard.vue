<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

type Topic = { _id: Id<'topics'>; name: string };

// The contact page's Topics card (admins only): the contact's topics with a
// remove button each, and a dropdown to add it to one more. The page owns the
// data and the writes (useContactTopics); this card owns only the dropdown.
defineProps<{
	contactTopics: ReadonlyArray<Topic> | null | undefined;
	allTopics: ReadonlyArray<Topic> | null | undefined;
	availableTopics: ReadonlyArray<Topic>;
	isAdding: boolean;
}>();

const emit = defineEmits<{
	add: [topicId: Id<'topics'>];
	remove: [topicId: Id<'topics'>];
}>();

const isAddToTopicDropdownOpen = defineModel<boolean>('open', { required: true });

const { t } = useI18n();

// Close dropdown when clicking outside
const addToTopicDropdownRef = ref<HTMLElement | null>(null);

useClickOutside(addToTopicDropdownRef, () => {
	isAddToTopicDropdownOpen.value = false;
});
</script>

<template>
	<div class="card">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-medium text-text-primary">
				{{ t('dashboard.audience.contacts.detail.topics.title') }}
			</h2>

			<!-- Add to Topic Dropdown -->
			<div ref="addToTopicDropdownRef" class="relative">
				<UiButton
					variant="secondary"
					size="sm"
					class="gap-1.5"
					:disabled="availableTopics.length === 0 || isAdding"
					@click.stop="isAddToTopicDropdownOpen = !isAddToTopicDropdownOpen"
				>
					<Icon
						v-if="isAdding"
						name="lucide:loader-2"
						class="w-3 h-3 animate-spin motion-reduce:animate-none"
					/>
					<Icon v-else name="lucide:plus" class="w-3 h-3" />
					{{ t('dashboard.audience.contacts.detail.topics.addToTopic') }}
					<Icon name="lucide:chevron-down" class="w-3 h-3" />
				</UiButton>

				<!-- Dropdown Menu -->
				<Transition
					enter-active-class="duration-(--motion-moderate) ease-spring"
					enter-from-class="opacity-0 translate-y-1"
					enter-to-class="opacity-100 translate-y-0"
					leave-active-class="duration-(--motion-moderate-exit) ease-exit"
					leave-from-class="opacity-100 translate-y-0"
					leave-to-class="opacity-0 translate-y-1"
				>
					<div
						v-if="isAddToTopicDropdownOpen && availableTopics.length > 0"
						class="absolute right-0 mt-2 w-56 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-10 py-1 max-h-64 overflow-y-auto"
					>
						<button
							v-for="list in availableTopics"
							:key="list._id"
							class="w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-surface flex items-center gap-2 transition-colors"
							:disabled="isAdding"
							@click="emit('add', list._id)"
						>
							<Icon name="lucide:tag" class="w-4 h-4 text-brand flex-shrink-0" />
							<span class="truncate">{{ list.name }}</span>
						</button>
					</div>
				</Transition>

				<!-- Empty Dropdown Message -->
				<Transition
					enter-active-class="duration-(--motion-moderate) ease-spring"
					enter-from-class="opacity-0 translate-y-1"
					enter-to-class="opacity-100 translate-y-0"
					leave-active-class="duration-(--motion-moderate-exit) ease-exit"
					leave-from-class="opacity-100 translate-y-0"
					leave-to-class="opacity-0 translate-y-1"
				>
					<div
						v-if="
							isAddToTopicDropdownOpen &&
							availableTopics.length === 0 &&
							allTopics &&
							allTopics.length > 0
						"
						class="absolute right-0 mt-2 w-56 bg-bg-elevated border border-border-subtle rounded-xl shadow-lg z-10 p-3"
					>
						<p class="text-sm text-text-tertiary text-center">
							{{ t('dashboard.audience.contacts.detail.topics.allTopics') }}
						</p>
					</div>
				</Transition>
			</div>
		</div>

		<div v-if="contactTopics && contactTopics.length > 0" class="space-y-2">
			<div
				v-for="list in contactTopics"
				:key="list._id"
				class="group flex items-center gap-2 p-2 rounded-lg bg-bg-surface"
			>
				<Icon name="lucide:tag" class="w-4 h-4 text-brand flex-shrink-0" />
				<div class="flex-1 min-w-0">
					<NuxtLink
						:to="`/dashboard/audience/topics/${list._id}`"
						class="text-text-primary text-sm truncate hover:text-brand transition-colors block"
					>
						{{ list.name }}
					</NuxtLink>
				</div>
				<UiTooltip :text="t('dashboard.audience.contacts.detail.topics.remove')">
					<button
						class="p-1 rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-error hover:bg-error-subtle transition-[color,background-color,opacity]"
						:aria-label="t('dashboard.audience.contacts.detail.topics.remove')"
						@click="emit('remove', list._id)"
					>
						<Icon name="lucide:x" class="w-3 h-3" />
					</button>
				</UiTooltip>
			</div>
		</div>
		<div v-else-if="allTopics && allTopics.length === 0" class="text-center py-4">
			<p class="text-text-tertiary text-sm">
				{{ t('dashboard.audience.contacts.detail.topics.noneCreated') }}
			</p>
			<NuxtLink to="/dashboard/audience/topics" class="text-brand text-sm hover:underline">
				{{ t('dashboard.audience.contacts.detail.topics.createOne') }}
			</NuxtLink>
		</div>
		<div v-else class="text-center py-4">
			<p class="text-text-tertiary text-sm">
				{{ t('dashboard.audience.contacts.detail.topics.none') }}
			</p>
		</div>
	</div>
</template>
