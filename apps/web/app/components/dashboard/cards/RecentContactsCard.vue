<script setup lang="ts">
import { api } from '@owlat/api';

const { data: contacts, isLoading } = useOrganizationQuery(
	api.contacts.analytics.getRecent,
	{ limit: 5 }
);

interface Contact {
	_id: string;
	// Optional: contacts can arrive via non-email channels (SMS/WhatsApp/phone).
	email?: string;
	firstName?: string;
	lastName?: string;
	_creationTime: number;
}

const contactList = computed<Contact[]>(() => {
	return (contacts.value as Contact[] | null) ?? [];
});

function getDisplayName(contact: Contact): string {
	const parts = [contact.firstName, contact.lastName].filter(Boolean);
	if (parts.length > 0) return parts.join(' ');
	return contact.email ?? 'Unknown';
}

function getInitials(contact: Contact): string {
	return personInitials(contact.firstName, contact.lastName, contact.email);
}
</script>

<template>
	<UiCard padding="none" overflow="hidden">
		<div class="p-5">
			<div class="flex items-center justify-between mb-4">
				<div class="flex items-center gap-2.5">
					<UiIconBox icon="lucide:users" size="sm" variant="brand" />
					<h3 class="text-sm font-semibold text-text-primary">Recent Contacts</h3>
				</div>
				<NuxtLink
					to="/dashboard/audience/contacts"
					class="text-xs font-medium text-brand hover:text-brand/80 transition-colors"
				>
					View all
				</NuxtLink>
			</div>

			<div v-if="isLoading" class="flex items-center justify-center py-6">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>

			<div v-else-if="contactList.length === 0" class="py-4 text-center">
				<p class="text-sm text-text-tertiary">No contacts yet</p>
			</div>

			<div v-else class="space-y-1">
				<div
					v-for="contact in contactList"
					:key="contact._id"
					class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-bg-surface transition-colors"
				>
					<div
						class="flex items-center justify-center w-7 h-7 rounded-full bg-brand-subtle text-brand text-xs font-semibold shrink-0"
					>
						{{ getInitials(contact) }}
					</div>
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium text-text-primary truncate">
							{{ getDisplayName(contact) }}
						</p>
						<p
							v-if="contact.firstName || contact.lastName"
							class="text-xs text-text-tertiary truncate"
						>
							{{ contact.email }}
						</p>
					</div>
					<span class="text-xs text-text-tertiary shrink-0">
						{{ formatCompactRelativeTime(contact._creationTime) }}
					</span>
				</div>
			</div>
		</div>
	</UiCard>
</template>
