<script setup lang="ts">
/**
 * Turn one of the admin's own mailboxes into a team inbox
 * (`mail/teamInboxConversion.convertToTeamInbox`). Typically an `info@` that
 * was connected as a personal account: it keeps its mail, folders and sending
 * connection, and the teammates picked here can read and send from it.
 *
 * The parent passes the mailboxes the backend says can be converted
 * (`convertibleMailboxes`), so everything offered here is something the
 * mutation will accept.
 */
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import type { Id } from '@owlat/api/dataModel';

type ConvertibleMailbox = FunctionReturnType<
	typeof api.mail.teamInboxConversion.convertibleMailboxes
>[number];

const props = defineProps<{
	open: boolean;
	mailboxes: ConvertibleMailbox[];
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
	(e: 'converted', mailbox: { mailboxId: Id<'mailboxes'>; address: string }): void;
}>();

const { t } = useI18n();
const { user } = useAuth();
const { members: orgMembers, fetchMembers, isLoadingMembers } = useOrganization();

const selectedMailboxId = ref<Id<'mailboxes'> | null>(null);
const displayName = ref('');
const selectedMemberIds = ref<string[]>([]);
const error = ref<string | null>(null);

const selectedMailbox = computed(
	() => props.mailboxes.find((mb) => mb.mailboxId === selectedMailboxId.value) ?? null
);

// Everyone in the org except the caller, who stays the inbox's owner.
const addableMembers = computed(() => orgMembers.value.filter((m) => m.userId !== user.value?.id));

// The name field follows the chosen mailbox. Keyed on the id, not the row: the
// list re-renders on every sync, and a new row object must not wipe what the
// admin is typing. Registered before the open watcher below, whose immediate run
// can preselect a mailbox during setup.
watch(selectedMailboxId, () => {
	displayName.value = selectedMailbox.value?.displayName ?? '';
});

// Start from a clean form each time the dialog opens, preselecting the only
// mailbox when there is just one.
watch(
	() => props.open,
	(isOpen) => {
		if (!isOpen) return;
		const first = props.mailboxes[0] ?? null;
		selectedMailboxId.value = props.mailboxes.length === 1 && first ? first.mailboxId : null;
		selectedMemberIds.value = [];
		error.value = null;
		void fetchMembers();
	},
	{ immediate: true }
);

function toggleMember(userId: string) {
	const index = selectedMemberIds.value.indexOf(userId);
	if (index === -1) selectedMemberIds.value.push(userId);
	else selectedMemberIds.value.splice(index, 1);
}

const convertOp = useBackendOperation(api.mail.teamInboxConversion.convertToTeamInbox, {
	label: () => t('components.postbox.teamInboxConvertDialog.operation'),
	inlineTarget: error,
});

async function convert() {
	const mailbox = selectedMailbox.value;
	if (!mailbox || convertOp.isLoading.value) return;
	const result = await convertOp.run({
		mailboxId: mailbox.mailboxId,
		memberUserIds: selectedMemberIds.value,
		displayName: displayName.value.trim() || undefined,
	});
	if (!result.ok) return;
	emit('converted', { mailboxId: mailbox.mailboxId, address: mailbox.address });
	emit('update:open', false);
}
</script>

<template>
	<UiModal
		:open="open"
		:title="t('components.postbox.teamInboxConvertDialog.title')"
		size="md"
		@update:open="emit('update:open', $event)"
	>
		<form class="space-y-5" data-testid="team-inbox-convert-form" @submit.prevent="convert">
			<p class="text-sm text-text-secondary max-w-prose">
				{{ t('components.postbox.teamInboxConvertDialog.description') }}
			</p>
			<div>
				<label for="team-inbox-convert-mailbox" class="text-sm font-medium block mb-1">
					{{ t('components.postbox.teamInboxConvertDialog.mailboxLabel') }}
				</label>
				<select
					id="team-inbox-convert-mailbox"
					v-model="selectedMailboxId"
					class="input w-full"
					data-testid="team-inbox-convert-mailbox"
				>
					<option :value="null" disabled>
						{{ t('components.postbox.teamInboxConvertDialog.mailboxPlaceholder') }}
					</option>
					<option v-for="mb in mailboxes" :key="mb.mailboxId" :value="mb.mailboxId">
						{{ mb.displayName ? `${mb.displayName} <${mb.address}>` : mb.address }}
					</option>
				</select>
			</div>
			<div>
				<label for="team-inbox-convert-name" class="text-sm font-medium block mb-1">
					{{ t('dashboard.preferences.addAccount.displayNameLabel') }}
				</label>
				<input
					id="team-inbox-convert-name"
					v-model="displayName"
					type="text"
					:placeholder="t('dashboard.preferences.addAccount.displayNamePlaceholderTeam')"
					class="input w-full"
				/>
			</div>
			<PostboxTeamMemberPicker
				:members="addableMembers"
				:selected-ids="selectedMemberIds"
				:loading="isLoadingMembers"
				@toggle="toggleMember"
			/>
			<p
				v-if="selectedMailbox"
				class="rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning"
				data-testid="team-inbox-convert-warning"
			>
				{{
					t('components.postbox.teamInboxConvertDialog.visibilityWarning', {
						address: selectedMailbox.address,
					})
				}}
			</p>
			<p v-if="error" class="text-sm text-error">{{ error }}</p>
		</form>
		<template #footer>
			<UiButton
				variant="secondary"
				:disabled="convertOp.isLoading.value"
				@click="emit('update:open', false)"
			>
				{{ t('common.cancel') }}
			</UiButton>
			<UiButton
				:loading="convertOp.isLoading.value"
				:disabled="!selectedMailbox"
				data-testid="team-inbox-convert-confirm"
				@click="convert"
			>
				{{ t('components.postbox.teamInboxConvertDialog.confirm') }}
			</UiButton>
		</template>
	</UiModal>
</template>
