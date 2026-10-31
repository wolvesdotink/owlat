<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import { contactHasEmail, contactPrimaryIdentity } from '~/utils/contactIdentity';

type Contact = {
	_id: Id<'contacts'>;
	email?: string;
	firstName?: string | null;
	lastName?: string | null;
	createdAt: number;
};

// Below `md` the columns can't fit, so the contacts list renders its rows as
// cards: one tap opens the contact, the checkbox still selects.
defineProps<{
	contacts: ReadonlyArray<Contact>;
	selectedIds: ReadonlySet<Id<'contacts'>>;
	canManage: boolean;
	isAllPageSelected: boolean;
	isSomePageSelected: boolean;
}>();

const emit = defineEmits<{
	'toggle-select-all': [];
	'toggle-select': [contactId: Id<'contacts'>];
	open: [contactId: Id<'contacts'>];
}>();

const { t } = useI18n();

/** First + last for the card list, which has no room for a column each. */
const contactName = (contact: { firstName?: string | null; lastName?: string | null }) =>
	[contact.firstName, contact.lastName].filter(Boolean).join(' ');
</script>

<template>
	<!-- The table's select-all sits in a `thead` the card list has no
	     room for, so bulk selection was desktop-only here. Full-width
	     row: it doubles as its own 44px touch target. -->
	<UiCheckbox
		v-if="canManage"
		:model-value="isAllPageSelected"
		:indeterminate="isSomePageSelected"
		:label="t('dashboard.audience.contacts.index.selectAllLoaded')"
		class="w-full px-4 py-3 border-b border-border-subtle transition-colors hover:bg-bg-surface"
		@update:model-value="emit('toggle-select-all')"
	/>
	<ul class="divide-y divide-border-subtle">
		<li
			v-for="contact in contacts"
			:key="contact._id"
			class="flex items-center gap-3 px-4 py-3 density-compact:py-2 transition-colors"
			:class="selectedIds.has(contact._id) ? 'bg-brand/5' : ''"
		>
			<UiCheckbox
				v-if="canManage"
				class="contact-select shrink-0"
				:model-value="selectedIds.has(contact._id)"
				:aria-label="
					t('dashboard.audience.contacts.index.selectContact', {
						email: contactPrimaryIdentity(contact, t),
					})
				"
				@update:model-value="emit('toggle-select', contact._id)"
			/>
			<button type="button" class="flex-1 min-w-0 text-left" @click="emit('open', contact._id)">
				<!-- Email, else name, else "Unnamed contact". The second line is the
				     name under an email, or says that there is no email. -->
				<span
					class="block font-medium truncate"
					:class="contactHasEmail(contact) ? 'text-text-primary' : 'text-text-secondary'"
					>{{ contactPrimaryIdentity(contact, t) }}</span
				>
				<span
					v-if="contactHasEmail(contact) && contactName(contact)"
					class="block text-sm text-text-secondary truncate"
				>
					{{ contactName(contact) }}
				</span>
				<span v-else-if="!contactHasEmail(contact)" class="block text-sm text-text-tertiary">
					{{ t('dashboard.audience.contacts.index.noEmail') }}
				</span>
				<span class="block text-xs text-text-tertiary mt-0.5">
					{{
						t('dashboard.audience.contacts.index.addedOn', {
							date: formatDate(contact.createdAt),
						})
					}}
				</span>
			</button>
			<Icon name="lucide:chevron-right" class="w-4 h-4 text-text-tertiary shrink-0" />
		</li>
	</ul>
</template>

<style scoped>
/* The card list's row checkbox paints at its native 16px, but a thumb needs
 * 44px. A transparent 44x44 pseudo-element centred on it grows the hit area
 * (sized, not inset, so the 16px box still gets a full 44px each way) without
 * moving anything in the row; `z-10` keeps the overlap with the row's own tap
 * target on the checkbox. */
.contact-select {
	position: relative;
	z-index: 10;
}

/* No text sits beside this box, so drop UiCheckbox's text-baseline nudge: the
 * label is then exactly the box and the hit area centres on it. */
.contact-select :deep(input) {
	margin-top: 0;
}

.contact-select::after {
	content: '';
	position: absolute;
	top: 50%;
	left: 50%;
	width: 44px;
	height: 44px;
	transform: translate(-50%, -50%);
}
</style>
