<script setup lang="ts">
/**
 * "Your data" (idea 67) — what this deployment keeps, for how long, and the two
 * things the owner can do about it.
 *
 * The account page already offered an export and a deletion. What it never said
 * is the thing people actually want to know: does anything here delete itself?
 * The answer is almost always no — Owlat keeps mail until its owner deletes it,
 * Trash and Spam included — and saying that plainly is worth more than any
 * amount of policy prose. The two horizons that DO exist (deliverability
 * evidence) are stated with the same numbers the sweeps enforce, read from
 * `@owlat/shared/retentionHorizons`.
 *
 * The one control is the trash auto-purge horizon, which defaults to Never so
 * that a mailbox nobody configures behaves exactly as it always has.
 *
 * "Download all my mail" lives here rather than beside the JSON export because
 * it is the same promise the retention list makes — your mail is yours, in a
 * format every other mail program reads (mbox), streamed to disk so the size of
 * the mailbox never matters.
 */
import type { PostboxTrashAutoPurgeDays } from '~/utils/postboxTrashRetention';
import {
	POSTBOX_TRASH_AUTO_PURGE_OPTIONS,
	dataRetentionStatements,
} from '~/utils/postboxTrashRetention';
import {
	MBOX_DOWNLOAD_KIND,
	isSaveFilePickerCancellation,
	openIncrementalDownload,
} from '~/utils/incrementalJsonDownload';
import { mboxExportFilename, writeMailboxMboxExport } from '~/utils/mboxExport';

const { t, locale } = useI18n();
const { showToast } = useToast();
const convex = useConvex();
const { currentMailbox } = usePostboxMailbox();
const { trashAutoPurgeDays, setTrashAutoPurgeDays, isSaving } = usePostboxSettings();

const statements = computed(() => dataRetentionStatements(trashAutoPurgeDays.value));

function onTrashHorizonChange(event: Event) {
	const value = Number((event.target as HTMLSelectElement).value) as PostboxTrashAutoPurgeDays;
	void setTrashAutoPurgeDays(value);
}

// ── Download all my mail (.mbox) ────────────────────────────────────────────
const isExportingMail = ref(false);
const exportedMessages = ref(0);

function formatCount(value: number): string {
	return new Intl.NumberFormat(locale.value).format(value);
}

async function downloadAllMail() {
	const mailboxId = currentMailbox.value?._id;
	if (!mailboxId || !convex || isExportingMail.value) return;
	isExportingMail.value = true;
	exportedMessages.value = 0;
	try {
		// The native picker needs the click's transient user activation, so the
		// destination is opened before the first network request — the same order
		// the JSON export uses.
		const sink = await openIncrementalDownload(mboxExportFilename(new Date()), MBOX_DOWNLOAD_KIND);
		const written = await writeMailboxMboxExport(convex, mailboxId, sink, ({ messages }) => {
			exportedMessages.value = messages;
		});
		showToast(
			t('components.preferences.preferencesYourData.mailExportDone', {
				count: formatCount(written),
			}),
			'success'
		);
	} catch (error) {
		if (isSaveFilePickerCancellation(error)) return;
		showToast(t('components.preferences.preferencesYourData.mailExportFailed'), 'error');
	} finally {
		isExportingMail.value = false;
	}
}
</script>

<template>
	<section class="card !p-0">
		<header class="px-5 py-4 border-b border-border-subtle flex items-center gap-3">
			<UiIconBox icon="lucide:shield-check" size="sm" variant="surface" rounded="lg" />
			<div class="min-w-0">
				<h2 class="font-semibold text-text-primary">
					{{ t('components.preferences.preferencesYourData.title') }}
				</h2>
				<p class="text-sm text-text-secondary">
					{{ t('components.preferences.preferencesYourData.subtitle') }}
				</p>
			</div>
		</header>

		<dl class="px-5 py-4 space-y-2">
			<div
				v-for="statement in statements"
				:key="statement.id"
				class="flex items-baseline justify-between gap-4 text-sm"
			>
				<dt class="text-text-secondary">{{ t(statement.labelKey) }}</dt>
				<dd class="text-text-primary text-right">
					{{ t(statement.valueKey, statement.params ?? {}) }}
				</dd>
			</div>
		</dl>

		<div class="px-5 py-4 border-t border-border-subtle flex items-center justify-between gap-4">
			<div class="min-w-0">
				<label for="trash-auto-purge" class="font-medium text-sm block">
					{{ t('components.preferences.preferencesYourData.trashPurgeLabel') }}
				</label>
				<p class="text-xs text-text-tertiary mt-0.5">
					{{ t('components.preferences.preferencesYourData.trashPurgeHelp') }}
				</p>
			</div>
			<select
				id="trash-auto-purge"
				class="input w-48 shrink-0"
				:value="trashAutoPurgeDays"
				:disabled="isSaving"
				@change="onTrashHorizonChange"
			>
				<option
					v-for="option in POSTBOX_TRASH_AUTO_PURGE_OPTIONS"
					:key="option.value"
					:value="option.value"
				>
					{{ t(option.label) }}
				</option>
			</select>
		</div>

		<div class="px-5 py-4 border-t border-border-subtle">
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<h3 class="font-medium text-sm">
						{{ t('components.preferences.preferencesYourData.mailExportTitle') }}
					</h3>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{ t('components.preferences.preferencesYourData.mailExportHelp') }}
					</p>
				</div>
				<UiButton
					variant="secondary"
					size="sm"
					class="gap-2 shrink-0"
					:disabled="isExportingMail || !currentMailbox"
					@click="downloadAllMail"
				>
					<Icon
						v-if="isExportingMail"
						name="lucide:loader-2"
						class="w-4 h-4 animate-spin motion-reduce:animate-none"
					/>
					<Icon v-else name="lucide:download" class="w-4 h-4" />
					{{
						isExportingMail
							? t('components.preferences.preferencesYourData.mailExportRunning')
							: t('components.preferences.preferencesYourData.mailExportAction')
					}}
				</UiButton>
			</div>
			<p v-if="isExportingMail" class="text-xs text-text-tertiary mt-2" aria-live="polite">
				{{
					t('components.preferences.preferencesYourData.mailExportProgress', {
						count: formatCount(exportedMessages),
					})
				}}
			</p>
		</div>
	</section>
</template>
