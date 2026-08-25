<script setup lang="ts">
/**
 * Personal address book for the current mailbox (api.mail.contacts). This is
 * NOT the org-wide Customers store under /dashboard/audience — that is a
 * different dataset owned by the team. These entries feed recipient
 * autocomplete, so this page is the only surface that can correct or remove a
 * stale one; the postbox rail and the command palette both link here.
 */
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

useHead({ title: () => t('dashboard.postbox.contacts.pageTitle') });
definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	requiresAnyFeature: ['postbox', 'mail.external'],
});

const { currentMailbox, isLoading: mailboxesLoading } = usePostboxMailbox();
const mailboxId = computed(() => currentMailbox.value?._id ?? null);
const { contacts, isLoading, save, remove } = usePostboxContacts(mailboxId);
type MailContact = (typeof contacts.value)[number];
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
function openEdit(c: MailContact) {
	form.value = {
		contactId: c._id,
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
	if (result.ok) editOpen.value = false;
}

// Removing a contact is no longer silent: it confirms with a toast that offers
// an immediate Undo, which re-adds the contact from the captured details.
async function removeContact(c: MailContact) {
	const result = await remove(c._id);
	if (!result.ok) return;
	showToast(
		t('dashboard.postbox.contacts.removedToast', { contact: c.displayName || c.email }),
		'success',
		{
			action: {
				label: t('dashboard.postbox.contacts.undo'),
				onAction: () => {
					void save({
						email: c.email,
						displayName: c.displayName,
						organization: c.organization,
					});
				},
			},
		}
	);
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
			<div>
				<h1 class="text-xl font-semibold text-text-primary">
					{{ t('dashboard.postbox.contacts.title') }}
				</h1>
				<p class="text-sm text-text-secondary">{{ t('dashboard.postbox.contacts.subtitle') }}</p>
			</div>
			<UiButton type="button" @click="openNew">
				<template #iconLeft><Icon name="lucide:user-plus" class="w-4 h-4" /></template>
				{{ t('dashboard.postbox.contacts.addContact') }}
			</UiButton>
		</header>

		<div class="relative mb-4">
			<Icon
				name="lucide:search"
				class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
			/>
			<input
				v-model="search"
				type="text"
				:placeholder="t('dashboard.postbox.contacts.searchPlaceholder')"
				class="input w-full pl-9"
			/>
		</div>

		<PostboxMailboxGuard :mailbox-id="mailboxId" :loading="mailboxesLoading">
			<div v-if="isLoading" class="flex justify-center py-12">
				<Icon name="lucide:loader-2" class="w-6 h-6 animate-spin text-text-tertiary" />
			</div>
			<div v-else-if="filtered.length === 0" class="text-center py-12">
				<Icon name="lucide:users" class="w-10 h-10 mx-auto text-text-tertiary" />
				<p class="text-sm text-text-secondary mt-3">
					{{
						search
							? t('dashboard.postbox.contacts.noMatches')
							: t('dashboard.postbox.contacts.empty')
					}}
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
					<!-- Row actions stay reachable for keyboard and touch users: they
					     only fade in on hover, never leave the tab order. -->
					<div
						class="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100"
					>
						<UiButton
							variant="ghost"
							size="sm"
							type="button"
							:title="t('dashboard.postbox.contacts.compose')"
							:aria-label="t('dashboard.postbox.contacts.composeAria')"
							@click="composeTo(c.email)"
						>
							<Icon name="lucide:pencil" class="w-4 h-4" />
						</UiButton>
						<UiButton
							variant="ghost"
							size="sm"
							type="button"
							:title="t('common.edit')"
							:aria-label="t('dashboard.postbox.contacts.editAria')"
							@click="openEdit(c)"
						>
							<Icon name="lucide:edit-2" class="w-4 h-4" />
						</UiButton>
						<UiButton
							variant="danger-ghost"
							size="sm"
							type="button"
							:title="t('common.remove')"
							:aria-label="t('dashboard.postbox.contacts.removeAria')"
							@click="removeContact(c)"
						>
							<Icon name="lucide:trash" class="w-4 h-4" />
						</UiButton>
					</div>
				</li>
			</ul>
		</PostboxMailboxGuard>

		<UiModal
			:open="editOpen"
			:title="
				form.contactId
					? t('dashboard.postbox.contacts.editContact')
					: t('dashboard.postbox.contacts.addContact')
			"
			size="sm"
			@update:open="
				(v) => {
					if (!v) editOpen = false;
				}
			"
		>
			<form class="space-y-3" @submit.prevent="submit">
				<div>
					<label for="form-email" class="text-xs font-medium text-text-tertiary block mb-1">
						{{ t('common.email') }}
					</label>
					<input
						id="form-email"
						v-model="form.email"
						type="email"
						required
						class="input w-full"
						:placeholder="t('dashboard.postbox.contacts.emailPlaceholder')"
					/>
				</div>
				<div>
					<label for="form-displayname" class="text-xs font-medium text-text-tertiary block mb-1">
						{{ t('common.name') }}
					</label>
					<input
						id="form-displayname"
						v-model="form.displayName"
						type="text"
						class="input w-full"
						:placeholder="t('dashboard.postbox.contacts.namePlaceholder')"
					/>
				</div>
				<div>
					<label for="form-organization" class="text-xs font-medium text-text-tertiary block mb-1">
						{{ t('dashboard.postbox.contacts.organization') }}
					</label>
					<input
						id="form-organization"
						v-model="form.organization"
						type="text"
						class="input w-full"
						:placeholder="t('dashboard.postbox.contacts.organizationPlaceholder')"
					/>
				</div>
				<div class="flex justify-end gap-2 pt-1">
					<UiButton variant="ghost" type="button" @click="editOpen = false">
						{{ t('common.cancel') }}
					</UiButton>
					<UiButton type="submit" :disabled="!canSave">{{ t('common.save') }}</UiButton>
				</div>
			</form>
		</UiModal>

		<PostboxComposerStack />
	</div>
</template>
