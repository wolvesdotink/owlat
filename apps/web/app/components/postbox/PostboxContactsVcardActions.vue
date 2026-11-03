<script setup lang="ts">
/**
 * Import and export of the Postbox address book as .vcf files, in the header
 * of /dashboard/postbox/contacts. Export is the way back out of an import, and
 * it writes every row, whatever built it.
 */
import type { Id } from '@owlat/api/dataModel';
import type { VcardContactEntry } from '@owlat/shared/postboxVcard';
import { VCARD_MAX_ENTRIES, VCARD_MAX_FILE_BYTES } from '@owlat/shared/postboxVcard';
import type { VcardImportOutcome } from '~/composables/postbox/usePostboxVcardTransfer';

const props = defineProps<{
	mailboxId: Id<'mailboxes'> | null;
	contacts: readonly VcardContactEntry[];
}>();

const { t } = useI18n();
const { showToast } = useToast();
const { isDesktop, pickNativeFiles } = useNativeFilePicker();
const { isImporting, importFile, exportContacts } = usePostboxVcardTransfer(
	toRef(props, 'mailboxId')
);
const fileInput = ref<HTMLInputElement | null>(null);

async function browse() {
	if (!isDesktop.value) {
		fileInput.value?.click();
		return;
	}
	const [file] = await pickNativeFiles({
		title: t('dashboard.postbox.contacts.vcard.pickerTitle'),
		filters: [{ name: 'vCard', extensions: ['vcf', 'vcard'] }],
	});
	if (file) await run(file);
}

async function onFileChosen(event: Event) {
	const input = event.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (file) await run(file);
}

async function run(file: File) {
	report(await importFile(file));
}

function report(outcome: VcardImportOutcome | null) {
	if (!outcome) return;
	if (outcome.kind === 'rejected') {
		const copy = {
			too_large: t('dashboard.postbox.contacts.vcard.tooLarge', {
				size: Math.round(VCARD_MAX_FILE_BYTES / (1024 * 1024)),
			}),
			wrong_type: t('dashboard.postbox.contacts.vcard.wrongType'),
			empty: t('dashboard.postbox.contacts.vcard.empty'),
		}[outcome.reason];
		showToast(copy, 'error');
		return;
	}
	const written = outcome.created + outcome.merged;
	const lines = [
		outcome.kind === 'done'
			? t('dashboard.postbox.contacts.vcard.imported', {
					created: outcome.created,
					merged: outcome.merged,
				})
			: t('dashboard.postbox.contacts.vcard.stopped', { count: written }, written),
	];
	if (outcome.skippedWithoutEmail > 0) {
		lines.push(
			t(
				'dashboard.postbox.contacts.vcard.skipped',
				{ count: outcome.skippedWithoutEmail },
				outcome.skippedWithoutEmail
			)
		);
	}
	if (outcome.isTruncated) {
		lines.push(t('dashboard.postbox.contacts.vcard.truncated', { max: VCARD_MAX_ENTRIES }));
	}
	showToast(lines.join(' '), outcome.kind === 'done' ? 'success' : 'warning');
}
</script>

<template>
	<div class="flex items-center gap-2">
		<input
			ref="fileInput"
			type="file"
			accept=".vcf,.vcard,text/vcard,text/x-vcard"
			class="hidden"
			:aria-label="t('dashboard.postbox.contacts.vcard.import')"
			@change="onFileChosen"
		/>
		<UiTooltip :text="t('dashboard.postbox.contacts.vcard.importHint')">
			<UiButton
				variant="secondary"
				type="button"
				:loading="isImporting"
				:disabled="!mailboxId || isImporting"
				@click="browse"
			>
				<template #iconLeft><Icon name="lucide:upload" class="w-4 h-4" /></template>
				{{ t('dashboard.postbox.contacts.vcard.import') }}
			</UiButton>
		</UiTooltip>
		<UiButton
			variant="secondary"
			type="button"
			:disabled="contacts.length === 0"
			@click="exportContacts(contacts)"
		>
			<template #iconLeft><Icon name="lucide:download" class="w-4 h-4" /></template>
			{{ t('dashboard.postbox.contacts.vcard.export') }}
		</UiButton>
	</div>
</template>
