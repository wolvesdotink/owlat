<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { ChevronDownIcon, CloseIcon, PlusIcon, TagIcon } from '@coolicons/vue';
import { SpinnerIcon } from '@owlat/ui/icons/SpinnerIcon';

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
</script>

<template>
	<div class="card">
		<div class="flex items-center justify-between mb-4">
			<h2 class="text-lg font-medium text-text-primary">
				{{ t('dashboard.audience.contacts.detail.topics.title') }}
			</h2>

			<!-- Add to Topic Dropdown. It opens while every topic is already
			     assigned, so it can say why there is nothing left to pick. -->
			<UiDropdownMenu v-model:open="isAddToTopicDropdownOpen" position="right">
				<template #trigger>
					<UiButton
						variant="secondary"
						size="sm"
						class="gap-1.5"
						:disabled="!allTopics || allTopics.length === 0 || isAdding"
					>
						<SpinnerIcon v-if="isAdding" class="w-3 h-3" />
						<PlusIcon v-else class="w-3 h-3" />
						{{ t('dashboard.audience.contacts.detail.topics.addToTopic') }}
						<ChevronDownIcon class="w-3 h-3" />
					</UiButton>
				</template>
				<template v-if="availableTopics.length > 0">
					<UiDropdownMenuItem
						v-for="list in availableTopics"
						:key="list._id"
						:icon="TagIcon"
						:disabled="isAdding"
						@click="emit('add', list._id)"
					>
						<span class="truncate">{{ list.name }}</span>
					</UiDropdownMenuItem>
				</template>
				<p v-else class="px-3 py-2 text-sm text-text-tertiary">
					{{ t('dashboard.audience.contacts.detail.topics.allTopics') }}
				</p>
			</UiDropdownMenu>
		</div>

		<div v-if="contactTopics && contactTopics.length > 0" class="space-y-2">
			<div
				v-for="list in contactTopics"
				:key="list._id"
				class="group flex items-center gap-2 p-2 rounded-lg bg-bg-surface"
			>
				<TagIcon class="w-4 h-4 text-brand flex-shrink-0" />
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
						type="button"
						class="inline-flex items-center justify-center p-1 pointer-coarse:size-11 rounded text-text-tertiary opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 hover:text-error hover:bg-error-subtle transition-[color,background-color,opacity]"
						:aria-label="`${t('dashboard.audience.contacts.detail.topics.remove')}: ${list.name}`"
						@click="emit('remove', list._id)"
					>
						<CloseIcon class="w-3 h-3" />
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
