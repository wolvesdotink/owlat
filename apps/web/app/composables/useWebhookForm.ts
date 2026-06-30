import { computed, ref, reactive } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useWebhookActions } from './useWebhookActions';

const CREATED_SECRET_KEY = 'webhook-created-secret';

// Available webhook events
export const WEBHOOK_EVENTS = [
	{ value: 'email.sent', label: 'Email Sent', description: 'When an email is sent' },
	{ value: 'email.delivered', label: 'Email Delivered', description: 'When an email is delivered' },
	{ value: 'email.opened', label: 'Email Opened', description: 'When an email is opened' },
	{
		value: 'email.clicked',
		label: 'Email Clicked',
		description: 'When a link in an email is clicked',
	},
	{ value: 'email.bounced', label: 'Email Bounced', description: 'When an email bounces' },
	{
		value: 'email.complained',
		label: 'Email Complained',
		description: 'When a spam complaint is received',
	},
	{
		value: 'contact.created',
		label: 'Contact Created',
		description: 'When a new contact is created',
	},
	{
		value: 'topic.unsubscribed',
		label: 'Topic Unsubscribed',
		description: 'When a contact unsubscribes from a topic',
	},
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]['value'];

export function useWebhookForm() {
	// Form-level error refs are bound as inline targets so `invalid_input` /
	// `already_exists` failures surface on the form instead of a toast.
	const createFormError = ref<string | null>('');
	const editFormError = ref<string | null>('');

	// Mutations (create + edit)
	const { run: createWebhook } = useBackendOperation(api.webhooks.endpoints.create, {
		label: 'Create webhook',
		inlineTarget: createFormError,
	});
	const { run: updateWebhook } = useBackendOperation(api.webhooks.endpoints.update, {
		label: 'Update webhook',
		inlineTarget: editFormError,
	});

	// ─── Toast ──────────────────────────────────────────────────────────

	const { showToast: showNotification } = useToast();

	// ─── Clipboard ────────────────────────────────────────────────────────

	const { copy, isCopied, reset: resetCopied } = useCopyToClipboard();

	// ─── Create ─────────────────────────────────────────────────────────

	const isCreateModalOpen = ref(false);
	const createForm = reactive({
		name: '',
		url: '',
		events: [] as WebhookEvent[],
	});
	const isCreating = ref(false);

	const createdWebhook = ref<{ name: string; url: string; secret: string } | null>(null);
	const showCreatedWebhook = ref(false);
	const copiedSecret = computed(() => isCopied(CREATED_SECRET_KEY));

	const openCreateModal = () => {
		createForm.name = '';
		createForm.url = '';
		createForm.events = [];
		createFormError.value = '';
		isCreateModalOpen.value = true;
	};

	const closeCreateModal = () => {
		isCreateModalOpen.value = false;
	};

	const toggleCreateEvent = (event: WebhookEvent) => {
		const index = createForm.events.indexOf(event);
		if (index === -1) {
			createForm.events.push(event);
		} else {
			createForm.events.splice(index, 1);
		}
	};

	const selectAllEvents = () => {
		createForm.events = WEBHOOK_EVENTS.map((e) => e.value) as unknown as WebhookEvent[];
	};

	const clearAllEvents = () => {
		createForm.events = [];
	};

	const handleCreate = async () => {

		createFormError.value = '';

		if (!createForm.name.trim()) {
			createFormError.value = 'Name is required';
			return;
		}

		if (!createForm.url.trim()) {
			createFormError.value = 'URL is required';
			return;
		}

		try {
			const parsedUrl = new URL(createForm.url);
			if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
				createFormError.value = 'URL must use HTTP or HTTPS protocol';
				return;
			}
		} catch {
			createFormError.value = 'Invalid URL format';
			return;
		}

		if (createForm.events.length === 0) {
			createFormError.value = 'At least one event must be selected';
			return;
		}

		isCreating.value = true;

		const result = await createWebhook({
			name: createForm.name.trim(),
			url: createForm.url.trim(),
			events: createForm.events,
		});
		isCreating.value = false;

		if (!result) return;

		closeCreateModal();

		createdWebhook.value = {
			name: result.name,
			url: result.url,
			secret: result.secret,
		};
		showCreatedWebhook.value = true;
		resetCopied();

		showNotification('Webhook created successfully');
	};

	const closeCreatedWebhookModal = () => {
		showCreatedWebhook.value = false;
		createdWebhook.value = null;
		resetCopied();
	};

	const copySecret = async () => {
		if (!createdWebhook.value) return;

		const ok = await copy(createdWebhook.value.secret, CREATED_SECRET_KEY);
		if (!ok) {
			showNotification('Failed to copy to clipboard', 'error');
		}
	};

	// ─── Edit ───────────────────────────────────────────────────────────

	const isEditModalOpen = ref(false);
	const editForm = reactive({
		id: '' as Id<'webhooks'>,
		name: '',
		url: '',
		events: [] as WebhookEvent[],
	});
	const isEditing = ref(false);

	const openEditModal = (webhook: {
		_id: Id<'webhooks'>;
		name: string;
		url: string;
		events: readonly WebhookEvent[];
	}) => {
		editForm.id = webhook._id;
		editForm.name = webhook.name;
		editForm.url = webhook.url;
		editForm.events = [...webhook.events];
		editFormError.value = '';
		isEditModalOpen.value = true;
	};

	const closeEditModal = () => {
		isEditModalOpen.value = false;
	};

	const toggleEditEvent = (event: WebhookEvent) => {
		const index = editForm.events.indexOf(event);
		if (index === -1) {
			editForm.events.push(event);
		} else {
			editForm.events.splice(index, 1);
		}
	};

	const handleEdit = async () => {
		editFormError.value = '';

		if (!editForm.name.trim()) {
			editFormError.value = 'Name is required';
			return;
		}

		if (!editForm.url.trim()) {
			editFormError.value = 'URL is required';
			return;
		}

		try {
			const parsedUrl = new URL(editForm.url);
			if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
				editFormError.value = 'URL must use HTTP or HTTPS protocol';
				return;
			}
		} catch {
			editFormError.value = 'Invalid URL format';
			return;
		}

		if (editForm.events.length === 0) {
			editFormError.value = 'At least one event must be selected';
			return;
		}

		isEditing.value = true;

		const result = await updateWebhook({
			webhookId: editForm.id,
			name: editForm.name.trim(),
			url: editForm.url.trim(),
			events: editForm.events,
		});
		isEditing.value = false;

		if (result === undefined) return;

		closeEditModal();
		showNotification('Webhook updated successfully');
	};

	// ─── Actions (delegated) ────────────────────────────────────────────

	const webhookActions = useWebhookActions(showNotification);

	// ─── Utilities ──────────────────────────────────────────────────────


	const getEventLabel = (event: string) => {
		const found = WEBHOOK_EVENTS.find((e) => e.value === event);
		return found?.label || event;
	};

	const expandedWebhookId = ref<Id<'webhooks'> | null>(null);

	const toggleExpanded = (webhookId: Id<'webhooks'>) => {
		if (expandedWebhookId.value === webhookId) {
			expandedWebhookId.value = null;
		} else {
			expandedWebhookId.value = webhookId;
		}
	};

	return {
		// Toast (global, shared with delegated sub-composables)
		showNotification,

		// Create
		isCreateModalOpen,
		createForm,
		createFormError,
		isCreating,
		openCreateModal,
		closeCreateModal,
		toggleCreateEvent,
		selectAllEvents,
		clearAllEvents,
		handleCreate,

		// Created webhook secret display
		createdWebhook,
		showCreatedWebhook,
		copiedSecret,
		closeCreatedWebhookModal,
		copySecret,

		// Edit
		isEditModalOpen,
		editForm,
		editFormError,
		isEditing,
		openEditModal,
		closeEditModal,
		toggleEditEvent,
		handleEdit,

		// Actions (delegated)
		...webhookActions,

		// Utilities
		formatDate,
		getEventLabel,
		expandedWebhookId,
		toggleExpanded,
	};
}
