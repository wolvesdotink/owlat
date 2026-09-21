import { computed, ref, watch, type ComputedRef } from 'vue';
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { languageSelectOptions, timezoneOptions } from '~/data/languageOptions';

/**
 * Compute the minimal set/remove operations needed to persist edited custom
 * property values. `edited` is keyed by propertyId, `current` holds the
 * already-stored value for each id. Only changed properties produce an op:
 * a non-empty new value is set, a cleared value is removed, unchanged values
 * are skipped. Values are trimmed before comparison so whitespace-only edits
 * are treated as empty.
 */
export function diffPropertyValues(
	propertyIds: string[],
	edited: Record<string, string>,
	current: Record<string, string>
): {
	toSet: { propertyId: string; value: string }[];
	toRemove: string[];
} {
	const toSet: { propertyId: string; value: string }[] = [];
	const toRemove: string[] = [];

	for (const propertyId of propertyIds) {
		const next = (edited[propertyId] ?? '').trim();
		const prev = (current[propertyId] ?? '').trim();
		if (next === prev) continue;
		if (next === '') {
			toRemove.push(propertyId);
		} else {
			toSet.push({ propertyId, value: next });
		}
	}

	return { toSet, toRemove };
}

interface DoiStatusBadge {
	/** Message key — this map is module scope, so it holds keys, not copy. */
	label: string;
	color: string;
	icon: string | null;
}

// Single source of truth for double-opt-in status presentation (label + colour + icon).
const DOI_STATUS_BADGES: Record<string, DoiStatusBadge> = {
	confirmed: {
		label: 'shared.useContactDetail.doiStatus.confirmed',
		color: 'text-success',
		icon: 'lucide:check-circle',
	},
	pending: {
		label: 'shared.useContactDetail.doiStatus.pending',
		color: 'text-warning',
		icon: 'lucide:clock',
	},
};

const DOI_STATUS_DEFAULT: DoiStatusBadge = { label: '', color: 'text-text-tertiary', icon: null };

const getDoiStatusBadge = (status: string | undefined): DoiStatusBadge =>
	(status ? DOI_STATUS_BADGES[status] : undefined) ?? DOI_STATUS_DEFAULT;

/**
 * Composable for contact detail page: edit form state, save/cancel handlers, display helpers.
 */
export function useContactDetail(contactId: ComputedRef<Id<'contacts'>>) {
	const router = useRouter();
	const { t } = useI18n();

	// DATA: Convex queries
	const { data: contact, isLoading: contactLoading } = useConvexQuery(
		api.contacts.contacts.get,
		() => ({
			contactId: contactId.value,
		})
	);

	const { data: properties } = useOrganizationQuery(api.contacts.properties.listByOrganization);

	const { data: propertyValues } = useConvexQuery(
		api.contacts.propertyValues.listByContact,
		() => ({
			contactId: contactId.value,
		})
	);

	// FORM STATE
	const isEditing = ref(false);
	const isSaving = ref(false);
	const isDeleting = ref(false);
	const showDeleteConfirm = ref(false);
	const saveError = ref<string | null>(null);

	// Mutations
	const { run: updateContact } = useBackendOperation(api.contacts.contacts.update, {
		label: () => t('shared.useContactDetail.updateContactOperation'),
		inlineTarget: saveError,
	});
	const { run: setPropertyValues } = useBackendOperation(api.contacts.propertyValues.bulkSet, {
		label: () => t('shared.useContactDetail.updatePropertiesOperation'),
		inlineTarget: saveError,
	});
	const { run: removePropertyValue } = useBackendOperation(api.contacts.propertyValues.remove, {
		label: () => t('shared.useContactDetail.clearPropertyOperation'),
		inlineTarget: saveError,
	});
	const { run: deleteContact } = useBackendOperation(api.contacts.contacts.remove, {
		label: () => t('shared.useContactDetail.deleteContactOperation'),
	});
	const { run: resendConfirmation } = useBackendOperation(api.topics.topics.resendDoiConfirmation, {
		label: () => t('shared.useContactDetail.resendConfirmationOperation'),
	});

	// Resend the double-opt-in confirmation email to a contact still in the
	// `pending` state — refreshes the token and re-schedules the email via the
	// backend `resendDoiConfirmation` mutation. The confirmation-link host is
	// resolved server-side from SITE_URL (never from the client) so the
	// token-bearing link can't be aimed at an attacker host.
	const isResendingDoi = ref(false);
	const resendDoiConfirmation = async (): Promise<{ success: boolean } | undefined> => {
		if (!contact.value || contact.value.doiStatus !== 'pending') return;
		isResendingDoi.value = true;
		const result = await resendConfirmation({
			contactId: contactId.value,
		});
		isResendingDoi.value = false;
		return result.ok ? result.result : undefined;
	};

	const editForm = ref({
		email: '',
		firstName: '',
		lastName: '',
		timezone: '',
		language: '',
	});

	// Editable custom-property values keyed by propertyId. Populated from the
	// stored property values when the user enters edit mode.
	const propertyForm = ref<Record<string, string>>({});

	const buildPropertyForm = (): Record<string, string> => {
		const form: Record<string, string> = {};
		for (const property of properties.value ?? []) {
			form[property._id] = getPropertyValue(property._id) ?? '';
		}
		return form;
	};

	// Initialize edit form when contact data loads
	watch(
		contact,
		(newContact) => {
			if (newContact) {
				editForm.value = {
					email: newContact.email ?? '',
					firstName: newContact.firstName ?? '',
					lastName: newContact.lastName ?? '',
					timezone: newContact.timezone ?? '',
					language: newContact.language ?? '',
				};
			}
		},
		{ immediate: true }
	);

	// ACTIONS
	const startEditing = () => {
		if (contact.value) {
			editForm.value = {
				email: contact.value.email ?? '',
				firstName: contact.value.firstName ?? '',
				lastName: contact.value.lastName ?? '',
				timezone: contact.value.timezone ?? '',
				language: contact.value.language ?? '',
			};
			propertyForm.value = buildPropertyForm();
			saveError.value = null;
			isEditing.value = true;
		}
	};

	const cancelEditing = () => {
		isEditing.value = false;
		saveError.value = null;
		if (contact.value) {
			editForm.value = {
				email: contact.value.email ?? '',
				firstName: contact.value.firstName ?? '',
				lastName: contact.value.lastName ?? '',
				timezone: contact.value.timezone ?? '',
				language: contact.value.language ?? '',
			};
			propertyForm.value = buildPropertyForm();
		}
	};

	const saveChanges = async () => {
		if (!contact.value) return;

		isSaving.value = true;

		const result = await updateContact({
			contactId: contactId.value,
			email: editForm.value.email,
			firstName: editForm.value.firstName || undefined,
			lastName: editForm.value.lastName || undefined,
			timezone: editForm.value.timezone || undefined,
			language: editForm.value.language || undefined,
		});
		if (!result.ok) {
			isSaving.value = false;
			return;
		}

		// Persist custom-property edits: set values that changed to a non-empty
		// string in one bulkSet, and clear properties the user emptied.
		const propertyIds = (properties.value ?? []).map((p) => p._id);
		const current: Record<string, string> = {};
		for (const id of propertyIds) {
			current[id] = getPropertyValue(id) ?? '';
		}
		const { toSet, toRemove } = diffPropertyValues(propertyIds, propertyForm.value, current);

		if (toSet.length > 0) {
			const setResult = await setPropertyValues({
				contactId: contactId.value,
				values: toSet.map((op) => ({
					propertyId: op.propertyId as Id<'contactProperties'>,
					value: op.value,
				})),
			});
			if (!setResult.ok) {
				isSaving.value = false;
				return;
			}
		}

		for (const propertyId of toRemove) {
			const removeResult = await removePropertyValue({
				contactId: contactId.value,
				propertyId: propertyId as Id<'contactProperties'>,
			});
			if (!removeResult.ok) {
				isSaving.value = false;
				return;
			}
		}

		isSaving.value = false;
		isEditing.value = false;
	};

	const confirmDelete = async () => {
		isDeleting.value = true;

		const result = await deleteContact({ contactId: contactId.value });
		if (!result.ok) {
			isDeleting.value = false;
			showDeleteConfirm.value = false;
			return;
		}
		router.push('/dashboard/audience/contacts');
	};

	// Dropdown catalogs — sourced from the single language/timezone home so the
	// contact detail picker can't drift from every other language/timezone
	// picker. Those catalogs are module scope, so they carry message keys: the
	// `{ value, label }` pairs the picker renders can only be built here, where a
	// translator is in hand. Computed, so the labels follow a locale switch.
	const translate = (key: string) => t(key);
	const commonTimezones = computed(() =>
		timezoneOptions.map((zone) => ({ value: zone.value, label: translate(zone.label) }))
	);
	const commonLanguages = computed(() => languageSelectOptions(translate));

	// COMPUTED: display helpers
	const getTimezoneLabel = (tz: string | undefined) => {
		if (!tz) return t('shared.useContactDetail.notSet');
		const found = commonTimezones.value.find((zone) => zone.value === tz);
		return found ? found.label : tz;
	};

	const getLanguageLabel = (lang: string | undefined) => {
		if (!lang) return t('shared.useContactDetail.notSet');
		const found = commonLanguages.value.find((l) => l.value === lang);
		return found ? found.label : lang;
	};

	const getPropertyValue = (propertyId: Id<'contactProperties'>) => {
		if (!propertyValues.value) return null;
		const value = propertyValues.value.find((v) => v.propertyId === propertyId);
		return value?.value ?? null;
	};

	// DOI Status helpers — derived from the shared DOI_STATUS_BADGES map, whose
	// labels are message keys (the map is module scope). An unknown status has no
	// label at all, and stays the empty string the page treats as "no badge".
	const getDoiStatusLabel = (status: string | undefined) => {
		const key = getDoiStatusBadge(status).label;
		return key ? t(key) : '';
	};
	const getDoiStatusColor = (status: string | undefined) => getDoiStatusBadge(status).color;
	const getDoiStatusIcon = (status: string | undefined): string | null =>
		getDoiStatusBadge(status).icon;

	return {
		// Data
		contact,
		contactLoading,
		properties,
		propertyValues,

		// Form state
		isEditing,
		isSaving,
		isDeleting,
		showDeleteConfirm,
		saveError,
		editForm,
		propertyForm,
		commonTimezones,
		commonLanguages,

		// Actions
		startEditing,
		cancelEditing,
		saveChanges,
		confirmDelete,
		resendDoiConfirmation,
		isResendingDoi,

		// Display helpers
		getTimezoneLabel,
		getLanguageLabel,
		getPropertyValue,
		getDoiStatusLabel,
		getDoiStatusColor,
		getDoiStatusIcon,
	};
}
