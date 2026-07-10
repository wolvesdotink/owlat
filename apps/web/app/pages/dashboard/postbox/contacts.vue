<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';

useHead({ title: 'Contacts — Owlat' });
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
const { contacts, isLoading, save, remove } = usePostboxContacts(mailboxId);
const stack = usePostboxComposerStack();
const { showToast } = useToast();

const search = ref('');
const filtered = computed(() => {
	const q = search.value.trim().toLowerCase();
	if (!q) return contacts.value;
	return contacts.value.filter(
		(c) =>
			c.email.toLowerCase().includes(q) ||
			(c.displayName ?? '').toLowerCase().includes(q) ||
			(c.organization ?? '').toLowerCase().includes(q)
	);
});

interface EditForm {
	contactId: Id<'mailContacts'> | null;
	email: string;
	displayName: string;
	organization: string;
}
const editOpen = ref(false);
const form = ref<EditForm>({ contactId: null, email: '', displayName: '', organization: '' });

function openNew() {
	form.value = { contactId: null, email: '', displayName: '', organization: '' };
	editOpen.value = true;
}
function openEdit(c: { _id: string; email: string; displayName?: string; organization?: string }) {
	form.value = {
		contactId: c._id as Id<'mailContacts'>,
		email: c.email,
		displayName: c.displayName ?? '',
		organization: c.organization ?? '',
	};
	editOpen.value = true;
}

const canSave = computed(() => form.value.email.trim().includes('@'));

async function submit() {
	if (!canSave.value) return;
	const result = await save({
		email: form.value.email.trim(),
		displayName: form.value.displayName.trim() || undefined,
		organization: form.value.organization.trim() || undefined,
	});
	if (result !== undefined) editOpen.value = false;
}

// Removing a contact is no longer silent: it confirms with a toast that offers
// an immediate Undo, which re-adds the contact from the captured details.
async function removeContact(c: {
	_id: string;
	email: string;
	displayName?: string;
	organization?: string;
}) {
	const result = await remove(c._id as Id<'mailContacts'>);
	if (result === undefined) return;
	showToast(`Removed ${c.displayName || c.email}`, 'success', {
		action: {
			label: 'Undo',
			onAction: () => {
				void save({
					email: c.email,
					displayName: c.displayName,
					organization: c.organization,
				});
			},
		},
	});
}

function composeTo(email: string) {
	if (!mailboxId.value) return;
	stack.open({ mailboxId: mailboxId.value, prefillTo: [email] });
}

function initial(c: { displayName?: string; email: string }) {
	return (c.displayName || c.email).charAt(0).toUpperCase();
}
</script>

<template>
	<div class="p-6 max-w-3xl mx-auto">
		<header class="flex items-center justify-between gap-4 mb-4">
			<h1 class="text-xl font-semibold text-text-primary">Contacts</h1>
			<button type="button" class="btn btn-primary" @click="openNew">
				<Icon name="lucide:user-plus" class="w-4 h-4 mr-1.5" />
				Add contact
			</button>
		</header>

		<div class="relative mb-4">
			<Icon
				name="lucide:search"
				class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
			/>
			<input v-model="search" type="text" placeholder="Search contacts" class="input w-full pl-9" />
		</div>

		<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
			<div v-if="isLoading" class="flex justify-center py-12">
				<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="filtered.length === 0" class="text-center py-12">
				<Icon name="lucide:users" class="w-10 h-10 mx-auto text-text-tertiary" />
				<p class="text-sm text-text-secondary mt-3">
					{{ search ? 'No matching contacts' : 'No contacts yet' }}
				</p>
			</div>
			<ul
				v-else
				class="divide-y divide-border-subtle border border-border-subtle rounded-lg overflow-hidden"
			>
				<li
					v-for="c in filtered"
					:key="c._id"
					class="group flex items-center gap-3 px-4 py-3 hover:bg-bg-surface"
					style="content-visibility: auto; contain-intrinsic-size: auto 64px"
				>
					<div
						class="w-9 h-9 rounded-full bg-brand-subtle text-brand flex items-center justify-center font-semibold flex-shrink-0"
					>
						{{ initial(c) }}
					</div>
					<div class="flex-1 min-w-0">
						<p class="text-sm font-medium text-text-primary truncate">
							{{ c.displayName || c.email }}
						</p>
						<p class="text-xs text-text-tertiary truncate">
							{{ c.email }}<span v-if="c.organization"> · {{ c.organization }}</span>
						</p>
					</div>
					<div class="flex items-center gap-1 opacity-0 group-hover:opacity-100">
						<button
							type="button"
							class="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary"
							title="Compose"
							aria-label="Compose to contact"
							@click="composeTo(c.email)"
						>
							<Icon name="lucide:pencil" class="w-4 h-4" />
						</button>
						<button
							type="button"
							class="p-1.5 rounded hover:bg-bg-elevated text-text-tertiary hover:text-text-primary"
							title="Edit"
							aria-label="Edit contact"
							@click="openEdit(c)"
						>
							<Icon name="lucide:edit-2" class="w-4 h-4" />
						</button>
						<button
							type="button"
							class="p-1.5 rounded hover:bg-error/10 text-text-tertiary hover:text-error"
							title="Remove"
							aria-label="Remove contact"
							@click="removeContact(c)"
						>
							<Icon name="lucide:trash" class="w-4 h-4" />
						</button>
					</div>
				</li>
			</ul>
		</PostboxMailboxGuard>

		<UiModal
			:open="editOpen"
			:title="form.contactId ? 'Edit contact' : 'Add contact'"
			size="sm"
			@update:open="
				(v) => {
					if (!v) editOpen = false;
				}
			"
		>
			<form class="space-y-3" @submit.prevent="submit">
				<div>
					<label for="form-email" class="text-xs font-medium text-text-tertiary block mb-1"
						>Email</label
					>
					<input
						id="form-email"
						v-model="form.email"
						type="email"
						required
						class="input w-full"
						placeholder="name@example.com"
					/>
				</div>
				<div>
					<label for="form-displayname" class="text-xs font-medium text-text-tertiary block mb-1"
						>Name</label
					>
					<input
						id="form-displayname"
						v-model="form.displayName"
						type="text"
						class="input w-full"
						placeholder="Full name"
					/>
				</div>
				<div>
					<label for="form-organization" class="text-xs font-medium text-text-tertiary block mb-1"
						>Organization</label
					>
					<input
						id="form-organization"
						v-model="form.organization"
						type="text"
						class="input w-full"
						placeholder="Company"
					/>
				</div>
				<div class="flex justify-end gap-2 pt-1">
					<button type="button" class="btn btn-ghost" @click="editOpen = false">Cancel</button>
					<button type="submit" class="btn btn-primary" :disabled="!canSave">Save</button>
				</div>
			</form>
		</UiModal>

		<PostboxComposerStack />
	</div>
</template>
