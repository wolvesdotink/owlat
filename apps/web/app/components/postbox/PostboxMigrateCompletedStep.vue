<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { formatNumber } from '~/utils/formatters';
import {
	BrainIcon,
	CheckIcon,
	PackageCheckCornerIcon,
	SparkleIcon,
	TriangleWarningIcon,
} from '@coolicons/vue';

/**
 * The mail import wizard's last step: what came across, what was left behind,
 * the offer to learn from an import that finished without it, and the
 * signature found in the imported Sent mail.
 */
const props = defineProps<{
	migration: {
		messagesImported?: number;
		messagesIndexed?: number;
		messagesFailed?: number;
	} | null;
	isAiIndexing: boolean;
	canLearn: boolean;
	learnBusy: boolean;
	/** The imported mailbox, which the detected signature is saved to. */
	mailboxId: Id<'mailboxes'> | null;
}>();

const emit = defineEmits<{ learn: [] }>();

const { t, locale } = useI18n();
const { showToast } = useToast();

/** Counts read as body copy, so they follow the active locale's grouping. */
function formatCount(value: number | undefined): string {
	return formatNumber(value ?? 0, locale.value);
}

/**
 * Messages the import walked past without storing — an ingest that failed, or a
 * message the server would not hand over. They are still on the remote server,
 * so re-running the import retries them.
 */
const skippedCount = computed(() => props.migration?.messagesFailed ?? 0);

/**
 * "Your mail history is in Owlat" is not true of an import that left messages
 * behind, and claiming it directly above the count that says otherwise is the
 * same kind of overstatement this screen used to make about the whole import.
 */
const completedBodyCopy = computed(() => {
	const prefix = 'dashboard.postbox.migrate.';
	if (skippedCount.value > 0) {
		return t(
			props.isAiIndexing ? `${prefix}completedPartialBodyWithAi` : `${prefix}completedPartialBody`
		);
	}
	return t(props.isAiIndexing ? `${prefix}completedBodyWithAi` : `${prefix}completedBody`);
});

// ── Detected signature (completion nice-touch) ──────────────────────────────
// After the import finishes we scan the imported Sent mail for a repeated
// trailing block and offer it pre-filled, so replies look like they did before.
const { data: suggestedSignature } = useConvexQuery(api.mail.signatures.suggestFromImport, () =>
	props.mailboxId ? { mailboxId: props.mailboxId } : 'skip'
);
const createSignatureOp = useBackendOperation(api.mail.signatures.create, {
	label: () => t('dashboard.postbox.migrate.saveSignatureOperation'),
});
// The page owns this flag: "Learn from this import" passes through the indexing
// step, which unmounts this one, and the offer must not come back afterwards
// (saving it again would create a second signature).
const signatureSaved = defineModel<boolean>('signatureSaved', { required: true });
function detectedSignatureHtml(text: string): string {
	const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	return `<div>${escaped.replace(/\n/g, '<br>')}</div>`;
}
async function saveDetectedSignature() {
	const mailboxId = props.mailboxId;
	const text = suggestedSignature.value;
	if (!mailboxId || !text) return;
	const res = await createSignatureOp.run({
		mailboxId,
		name: t('dashboard.postbox.migrate.importedSignatureName'),
		html: detectedSignatureHtml(text),
		isDefault: true,
	});
	if (res.ok) {
		signatureSaved.value = true;
		showToast(t('dashboard.postbox.migrate.toastSignatureSaved'), 'success');
	}
}
</script>

<template>
	<section class="space-y-5">
		<UiCard padding="lg">
			<div class="text-center py-2">
				<UiIconBox
					:icon="skippedCount > 0 ? PackageCheckCornerIcon : SparkleIcon"
					size="xl"
					:variant="skippedCount > 0 ? 'warning' : 'success'"
					rounded="2xl"
					class="mx-auto"
				/>
				<h2 class="text-xl font-semibold mt-4">
					{{
						skippedCount > 0
							? t('dashboard.postbox.migrate.completedPartialTitle')
							: t('dashboard.postbox.migrate.completedTitle')
					}}
				</h2>
				<p class="text-text-secondary mt-1">
					{{ completedBodyCopy }}
				</p>

				<div class="grid grid-cols-2 gap-3 mt-6 text-left">
					<div class="rounded-xl bg-text-tertiary/5 p-4">
						<p class="text-2xl font-medium tracking-[-0.02em]">
							{{ formatCount(migration?.messagesImported) }}
						</p>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('dashboard.postbox.migrate.statMessagesImported') }}
						</p>
					</div>
					<div v-if="isAiIndexing" class="rounded-xl bg-text-tertiary/5 p-4">
						<p class="text-2xl font-medium tracking-[-0.02em]">
							{{ formatCount(migration?.messagesIndexed) }}
						</p>
						<p class="text-xs text-text-tertiary mt-0.5">
							{{ t('dashboard.postbox.migrate.statConversationsLearned') }}
						</p>
					</div>
				</div>

				<div
					v-if="skippedCount > 0"
					class="mt-6 rounded-xl border border-warning/20 bg-warning/5 p-4 text-left flex items-start gap-3"
				>
					<UiIconBox
						:icon="TriangleWarningIcon"
						size="sm"
						variant="warning"
						rounded="lg"
						class="mt-0.5"
					/>
					<div>
						<p class="text-sm font-medium">
							{{
								t('dashboard.postbox.migrate.skippedTitle', skippedCount, {
									named: { count: formatCount(skippedCount) },
								})
							}}
						</p>
						<p class="text-xs text-text-secondary mt-0.5">
							{{ t('dashboard.postbox.migrate.skippedBody') }}
						</p>
					</div>
				</div>

				<div
					v-if="canLearn"
					data-testid="migrate-learn"
					class="mt-6 rounded-xl border border-border-subtle p-4 text-left flex items-start gap-3"
				>
					<UiIconBox :icon="BrainIcon" size="sm" variant="surface" rounded="lg" class="mt-0.5" />
					<div class="flex-1">
						<p class="text-sm font-medium">{{ t('dashboard.postbox.migrate.learnTitle') }}</p>
						<p class="text-xs text-text-secondary mt-0.5">
							{{ t('dashboard.postbox.migrate.learnBody') }}
						</p>
						<UiButton
							class="mt-3"
							size="sm"
							variant="secondary"
							:loading="learnBusy"
							@click="emit('learn')"
						>
							{{ t('dashboard.postbox.migrate.learnAction') }}
						</UiButton>
					</div>
				</div>

				<div class="flex flex-col sm:flex-row gap-3 justify-center mt-7">
					<UiButton variant="primary" @click="navigateTo('/dashboard/postbox/inbox')">
						{{ t('dashboard.postbox.migrate.openInbox') }}
					</UiButton>
					<UiButton
						v-if="isAiIndexing"
						variant="secondary"
						@click="navigateTo('/dashboard/knowledge')"
					>
						{{ t('dashboard.postbox.migrate.seeWhatAiLearned') }}
					</UiButton>
				</div>

				<!-- Detected signature: offer the block we found in imported sent mail. -->
				<div
					v-if="suggestedSignature && !signatureSaved"
					class="mt-7 text-left rounded-xl border border-border-subtle bg-bg-surface p-4"
				>
					<p class="text-sm font-medium">
						{{ t('dashboard.postbox.migrate.signatureFoundTitle') }}
					</p>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{ t('dashboard.postbox.migrate.signatureFoundBody') }}
					</p>
					<pre
						class="mt-3 text-xs text-text-secondary whitespace-pre-wrap font-sans bg-text-tertiary/5 rounded-lg p-3"
						>{{ suggestedSignature }}</pre>
					<div class="mt-3 flex items-center gap-3">
						<UiButton
							size="sm"
							variant="secondary"
							:loading="createSignatureOp.isLoading.value"
							@click="saveDetectedSignature"
						>
							{{ t('dashboard.postbox.migrate.useThisSignature') }}
						</UiButton>
						<NuxtLink
							to="/dashboard/preferences/signatures"
							class="text-xs text-text-tertiary hover:text-text-primary"
						>
							{{ t('dashboard.postbox.migrate.editSignatureFirst') }}
						</NuxtLink>
					</div>
				</div>
				<p
					v-else-if="signatureSaved"
					class="text-xs text-success mt-6 inline-flex items-center gap-1"
				>
					<CheckIcon class="w-3.5 h-3.5" />
					{{ t('dashboard.postbox.migrate.signatureSaved') }}
				</p>
				<I18nT
					v-else
					keypath="dashboard.postbox.migrate.signatureTip"
					tag="p"
					scope="global"
					class="text-xs text-text-tertiary mt-6"
				>
					<template #link>
						<NuxtLink to="/dashboard/preferences/signatures" class="text-brand hover:underline">
							{{ t('dashboard.postbox.migrate.signatureTipLink') }}
						</NuxtLink>
					</template>
				</I18nT>
			</div>
		</UiCard>
	</section>
</template>
