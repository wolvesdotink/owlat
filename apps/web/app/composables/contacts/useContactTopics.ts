/**
 * The contact page's topic memberships: the contact's topics, the ones it can
 * still join, and adding or removing it with a toast. The page creates this so
 * the subscriptions keep the page's lifetime; the Topics card only renders it.
 */
import type { ComputedRef } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

export function useContactTopics(contactId: ComputedRef<Id<'contacts'>>) {
	const { t } = useI18n();
	const { showToast } = useToast();

	const { data: contactTopics } = useConvexQuery(api.topics.topics.getTopicsForContact, () => ({
		contactId: contactId.value,
	}));

	const { results: allTopics } = useTopicsList();

	const { run: addToTopic } = useBackendOperation(api.topics.topics.addContact, {
		label: () => t('dashboard.audience.contacts.detail.operations.addToTopic'),
	});
	const { run: removeFromTopic } = useBackendOperation(api.topics.topics.removeContact, {
		label: () => t('dashboard.audience.contacts.detail.operations.removeFromTopic'),
	});

	// Add to Topic Dropdown State
	const isAddToTopicDropdownOpen = ref(false);
	const isAddingToTopic = ref(false);

	const availableTopicsToAdd = computed(() => {
		if (!allTopics.value || !contactTopics.value) return [];
		const currentTopicIds = new Set(contactTopics.value.map((t) => t._id));
		return allTopics.value.filter((topic) => !currentTopicIds.has(topic._id));
	});

	const handleAddToTopic = async (topicId: Id<'topics'>) => {
		isAddingToTopic.value = true;

		const result = await addToTopic({
			topicId,
			contactId: contactId.value,
		});
		isAddingToTopic.value = false;
		if (!result.ok) return;
		const topicName =
			allTopics.value?.find((topic) => topic._id === topicId)?.name ||
			t('dashboard.audience.contacts.detail.topicFallback');
		showToast(t('dashboard.audience.contacts.detail.toasts.addedToTopic', { topic: topicName }));
		isAddToTopicDropdownOpen.value = false;
	};

	const handleRemoveFromTopic = async (topicId: Id<'topics'>) => {
		const result = await removeFromTopic({
			topicId,
			contactId: contactId.value,
		});
		if (!result.ok) return;
		const topicName =
			contactTopics.value?.find((topic) => topic._id === topicId)?.name ||
			t('dashboard.audience.contacts.detail.topicFallback');
		showToast(
			t('dashboard.audience.contacts.detail.toasts.removedFromTopic', { topic: topicName })
		);
	};

	return {
		contactTopics,
		allTopics,
		isAddToTopicDropdownOpen,
		isAddingToTopic,
		availableTopicsToAdd,
		handleAddToTopic,
		handleRemoveFromTopic,
	};
}
