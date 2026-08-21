import { computed, ref, reactive } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { useWebhookActions } from './useWebhookActions';

const CREATED_SECRET_KEY = 'webhook-created-secret';

/** Message-key root for this module; see `i18n/locales/en.json`. */
const K = 'shared.useWebhookForm';

/**
 * Available webhook events. A module-scope definition set cannot call `useI18n`,
 * so `label`/`description` carry message KEYS (the registry convention) and the
 * component that renders them translates with `t(...)`.
 */
export const WEBHOOK_EVENTS = [
	{
		value: 'email.sent',
		label: `${K}.events.emailSent.label`,
		description: `${K}.events.emailSent.description`,
	},
	{
		value: 'email.delivered',
		label: `${K}.events.emailDelivered.label`,
		description: `${K}.events.emailDelivered.description`,
	},
	{
		value: 'email.opened',
		label: `${K}.events.emailOpened.label`,
		description: `${K}.events.emailOpened.description`,
	},
	{
		value: 'email.clicked',
		label: `${K}.events.emailClicked.label`,
		description: `${K}.events.emailClicked.description`,
	},
	{
		value: 'email.bounced',
		label: `${K}.events.emailBounced.label`,
		description: `${K}.events.emailBounced.description`,
	},
	{
		value: 'email.complained',
		label: `${K}.events.emailComplained.label`,
		description: `${K}.events.emailComplained.description`,
	},
	{
		value: 'contact.created',
		label: `${K}.events.contactCreated.label`,
		description: `${K}.events.contactCreated.description`,
	},
	{
		value: 'topic.unsubscribed',
		label: `${K}.events.topicUnsubscribed.label`,
		description: `${K}.events.topicUnsubscribed.description`,
	},
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number]['value'];

export function useWebhookForm() {
	const { t } = useI18n();

	// Form-level error refs are bound as inline targets so `invalid_input` /
	// `already_exists` failures surface on the form instead of a toast.
	const createFormError = ref<string | null>('');
	const editFormError = ref<string | null>('');

	// Mutations (create + edit)
	const { run: createWebhook } = useBackendOperation(api.webhooks.endpoints.create, {
		label: () => t(`${K}.createOperation`),
		inlineTarget: createFormError,
	});
	const { run: updateWebhook } = useBackendOperation(api.webhooks.endpoints.update, {
		label: () => t(`${K}.updateOperation`),
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
		createForm.events = WEBHOOK_EVENTS.map((e): WebhookEvent => e.value);
	};

	const clearAllEvents = () => {
		createForm.events = [];
	};

	const handleCreate = async () => {
		createFormError.value = '';

		if (!createForm.name.trim()) {
			createFormError.value = t(`${K}.errors.nameRequired`);
			return;
		}

		if (!createForm.url.trim()) {
			createFormError.value = t(`${K}.errors.urlRequired`);
			return;
		}

		try {
			const parsedUrl = new URL(createForm.url);
			if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
				createFormError.value = t(`${K}.errors.urlProtocol`);
				return;
			}
		} catch {
			createFormError.value = t(`${K}.errors.urlInvalid`);
			return;
		}

		if (createForm.events.length === 0) {
			createFormError.value = t(`${K}.errors.eventsRequired`);
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

		showNotification(t(`${K}.created`));
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
			showNotification(t(`${K}.copyFailed`), 'error');
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
			editFormError.value = t(`${K}.errors.nameRequired`);
			return;
		}

		if (!editForm.url.trim()) {
			editFormError.value = t(`${K}.errors.urlRequired`);
			return;
		}

		try {
			const parsedUrl = new URL(editForm.url);
			if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
				editFormError.value = t(`${K}.errors.urlProtocol`);
				return;
			}
		} catch {
			editFormError.value = t(`${K}.errors.urlInvalid`);
			return;
		}

		if (editForm.events.length === 0) {
			editFormError.value = t(`${K}.errors.eventsRequired`);
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
		showNotification(t(`${K}.updated`));
	};

	// ─── Actions (delegated) ────────────────────────────────────────────

	const webhookActions = useWebhookActions(showNotification);

	// ─── Utilities ──────────────────────────────────────────────────────

	/**
	 * The message KEY for an event's label, or the raw event id when no definition
	 * owns it — the caller renders both through `t(…)` (an id with nothing to
	 * translate reads as itself).
	 */
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
