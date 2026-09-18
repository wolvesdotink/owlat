<script setup lang="ts">
/**
 * Import a team inbox's EXISTING mail, from the admin roster page.
 *
 * A connected team inbox starts empty: the sync worker seeds its cursor at the
 * moment of connection, so only mail that arrives afterwards ever lands. This
 * panel is the explicit, owner/admin-triggered pull of everything that came
 * before — the team's own archive, searchable in Postbox, and the material the
 * writing-voice profile learns the team's tone from.
 *
 * It is the personal wizard's progress surface (pages/dashboard/postbox/
 * migrate.vue) reduced to one inbox and one card: the same
 * `deriveMigrationStep` states, the same bar, the same counts — via
 * `useSharedMailMigration`, so the two can never disagree about what
 * "importing" looks like.
 *
 * Learning from the mail is OPT-IN here and on by default in the personal
 * wizard, because a team's history belongs to the org rather than to whoever
 * happens to be the admin clicking the button.
 */
import type { Id } from '@owlat/api/dataModel';
import { formatNumber } from '~/utils/formatters';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	/** The inbox address, so the confirmation copy names what is being imported. */
	address?: string;
}>();

const { t, locale } = useI18n();
const { showToast } = useToast();
const { isEnabled } = useFeatureFlag();

const {
	migration,
	step,
	isLoading,
	importPercent,
	indexPercent,
	isAiIndexing,
	isDiscovering,
	start,
	cancel,
	startBusy,
	cancelBusy,
} = useSharedMailMigration(() => props.mailboxId);

// The checkbox only exists where the knowledge graph does — the backend honours
// `indexKnowledge` solely when `ai.knowledge` is on, so offering it otherwise
// would be a control that silently does nothing.
const knowledgeAvailable = computed(() => isEnabled('ai.knowledge'));
const indexKnowledge = ref(false);

// 'connect' can't happen for a team inbox (it only exists once its connection
// does), but treat it as idle rather than rendering nothing if it ever does.
const isIdle = computed(() => step.value === 'ready' || step.value === 'connect');

async function handleStart() {
	const res = await start({ indexKnowledge: knowledgeAvailable.value && indexKnowledge.value });
	if (res.ok) showToast(t('dashboard.admin.team.inboxes.import.toastStarted'), 'success');
}

const showCancel = ref(false);
async function handleCancel() {
	const res = await cancel();
	showCancel.value = false;
	if (res.ok) showToast(t('dashboard.admin.team.inboxes.import.toastCancelled'), 'success');
}

// A worker error is a raw provider string and can be paragraphs long; show
// enough to recognise it and keep the card readable.
const ERROR_PREVIEW_LENGTH = 200;
/** Messages the walk passed over without storing — still on the remote server. */
const skippedCount = computed(() => migration.value?.messagesFailed ?? 0);

const errorPreview = computed(() => {
	const message = migration.value?.lastError;
	if (!message) return null;
	return message.length > ERROR_PREVIEW_LENGTH
		? `${message.slice(0, ERROR_PREVIEW_LENGTH)}…`
		: message;
});
</script>

<template>
	<div data-testid="team-inbox-import" class="space-y-4">
		<div>
			<h3 class="font-semibold text-text-primary">
				{{ t('dashboard.admin.team.inboxes.import.title') }}
			</h3>
			<p class="text-sm text-text-secondary mt-1">
				{{ t('dashboard.admin.team.inboxes.import.description') }}
			</p>
		</div>

		<!-- ── Loading: neither subscription has reported yet ───────────────────
		     Without this the derivation's default reads as "nothing is running",
		     so an inbox mid-import would flash the Start button before flipping
		     to a progress bar. -->
		<div v-if="isLoading" data-testid="team-inbox-import-loading" class="p-4 flex justify-center">
			<Icon
				name="lucide:loader-2"
				class="w-5 h-5 animate-spin motion-reduce:animate-none text-text-tertiary"
			/>
		</div>

		<!-- ── Idle: explain, offer the opt-in, start ───────────────────────── -->
		<div v-else-if="isIdle" class="space-y-4">
			<p class="text-xs text-text-tertiary">
				{{ t('dashboard.admin.team.inboxes.import.idleNote') }}
			</p>
			<UiCheckbox
				v-if="knowledgeAvailable"
				v-model="indexKnowledge"
				data-testid="team-inbox-import-knowledge"
				:label="t('dashboard.admin.team.inboxes.import.knowledgeLabel')"
				:description="t('dashboard.admin.team.inboxes.import.knowledgeDescription')"
			/>
			<UiButton
				data-testid="team-inbox-import-start"
				variant="primary"
				size="sm"
				:loading="startBusy"
				@click="handleStart"
			>
				<Icon name="lucide:download" class="w-4 h-4 mr-1.5" />
				{{ t('dashboard.admin.team.inboxes.import.start') }}
			</UiButton>
		</div>

		<!-- ── Stale credentials: repairing them comes first ────────────────── -->
		<p
			v-else-if="step === 'reconnect'"
			data-testid="team-inbox-import-reconnect"
			class="text-sm text-text-secondary"
		>
			{{ t('dashboard.admin.team.inboxes.import.reconnectFirst') }}
		</p>

		<!-- ── Importing ────────────────────────────────────────────────────── -->
		<div v-else-if="step === 'importing'" data-testid="team-inbox-import-running" class="space-y-3">
			<p class="text-sm text-text-secondary">
				{{
					isDiscovering
						? t('dashboard.admin.team.inboxes.import.discovering')
						: t('dashboard.admin.team.inboxes.import.importing')
				}}
			</p>
			<UiProgressBar
				:value="importPercent"
				size="sm"
				:indeterminate="isDiscovering"
				:aria-label="t('dashboard.admin.team.inboxes.import.progressLabel')"
			/>
			<div class="flex items-center justify-between text-xs text-text-tertiary">
				<span v-if="isDiscovering">{{
					t('dashboard.admin.team.inboxes.import.discoveringFolders')
				}}</span>
				<span v-else>
					{{
						t('dashboard.admin.team.inboxes.import.count', {
							imported: formatNumber(migration?.messagesImported, locale),
							total: formatNumber(migration?.messagesTotal, locale),
						})
					}}
				</span>
				<span v-if="!isDiscovering">{{ importPercent }}%</span>
			</div>
			<UiButton variant="danger-ghost" size="sm" @click="showCancel = true">
				{{ t('dashboard.admin.team.inboxes.import.cancel') }}
			</UiButton>
		</div>

		<!-- ── Indexing (learning from the imported mail) ───────────────────── -->
		<div v-else-if="step === 'indexing'" data-testid="team-inbox-import-indexing" class="space-y-3">
			<p class="text-sm text-text-secondary">
				{{ t('dashboard.admin.team.inboxes.import.indexing') }}
			</p>
			<UiProgressBar
				:value="indexPercent"
				variant="success"
				size="sm"
				:aria-label="t('dashboard.admin.team.inboxes.import.indexProgressLabel')"
			/>
			<div class="flex items-center justify-between text-xs text-text-tertiary">
				<span>
					{{
						t('dashboard.admin.team.inboxes.import.indexCount', {
							indexed: formatNumber(migration?.messagesIndexed, locale),
							imported: formatNumber(migration?.messagesImported, locale),
						})
					}}
				</span>
				<span>{{ indexPercent }}%</span>
			</div>
			<UiButton variant="danger-ghost" size="sm" @click="showCancel = true">
				{{ t('dashboard.admin.team.inboxes.import.cancel') }}
			</UiButton>
		</div>

		<!-- ── Completed ────────────────────────────────────────────────────── -->
		<div
			v-else-if="step === 'completed'"
			data-testid="team-inbox-import-completed"
			class="space-y-3"
		>
			<div class="flex items-start gap-2">
				<Icon name="lucide:check-circle-2" class="w-4 h-4 mt-0.5 text-success shrink-0" />
				<div>
					<p class="text-sm text-text-primary">
						{{
							t('dashboard.admin.team.inboxes.import.completed', {
								imported: formatNumber(migration?.messagesImported, locale),
							})
						}}
					</p>
					<p v-if="isAiIndexing" class="text-xs text-text-tertiary mt-0.5">
						{{
							t('dashboard.admin.team.inboxes.import.completedIndexed', {
								indexed: formatNumber(migration?.messagesIndexed, locale),
							})
						}}
					</p>
					<p v-if="skippedCount > 0" class="text-xs text-warning mt-0.5">
						{{
							t('dashboard.admin.team.inboxes.import.completedSkipped', skippedCount, {
								named: { count: formatNumber(skippedCount, locale) },
							})
						}}
					</p>
				</div>
			</div>
			<!-- The backend starts a fresh run on a completed job — for folders the
			     team added since, or mail a first pass cut short — so offer that
			     here. Without it the only way back to a Start button is
			     disconnecting the inbox. -->
			<UiButton
				data-testid="team-inbox-import-again"
				variant="secondary"
				size="sm"
				:loading="startBusy"
				@click="handleStart"
			>
				{{ t('dashboard.admin.team.inboxes.import.startAgain') }}
			</UiButton>
		</div>

		<!-- ── Failed ───────────────────────────────────────────────────────── -->
		<div v-else-if="step === 'failed'" data-testid="team-inbox-import-failed" class="space-y-3">
			<div class="flex items-start gap-2">
				<Icon name="lucide:triangle-alert" class="w-4 h-4 mt-0.5 text-error shrink-0" />
				<div>
					<p class="text-sm text-text-primary">
						{{ t('dashboard.admin.team.inboxes.import.failed') }}
					</p>
					<p v-if="errorPreview" class="text-xs text-error mt-0.5 break-words">
						{{ errorPreview }}
					</p>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{
							t('dashboard.admin.team.inboxes.import.failedKept', {
								imported: formatNumber(migration?.messagesImported, locale),
							})
						}}
					</p>
				</div>
			</div>
			<UiButton
				data-testid="team-inbox-import-retry"
				variant="secondary"
				size="sm"
				:loading="startBusy"
				@click="handleStart"
			>
				{{ t('dashboard.admin.team.inboxes.import.retry') }}
			</UiButton>
		</div>

		<!-- ── Cancelled ────────────────────────────────────────────────────── -->
		<div
			v-else-if="step === 'cancelled'"
			data-testid="team-inbox-import-cancelled"
			class="space-y-3"
		>
			<p class="text-sm text-text-secondary">
				{{
					t('dashboard.admin.team.inboxes.import.cancelled', {
						imported: formatNumber(migration?.messagesImported, locale),
					})
				}}
			</p>
			<UiButton
				data-testid="team-inbox-import-restart"
				variant="secondary"
				size="sm"
				:loading="startBusy"
				@click="handleStart"
			>
				{{ t('dashboard.admin.team.inboxes.import.startAgain') }}
			</UiButton>
		</div>

		<UiConfirmationDialog
			:open="showCancel"
			variant="warning"
			:title="t('dashboard.admin.team.inboxes.import.cancelDialog.title')"
			:description="
				t('dashboard.admin.team.inboxes.import.cancelDialog.description', {
					address: address ?? t('dashboard.admin.team.inboxes.import.cancelDialog.thisInbox'),
				})
			"
			:confirm-text="t('dashboard.admin.team.inboxes.import.cancel')"
			:is-loading="cancelBusy"
			@confirm="handleCancel"
			@cancel="showCancel = false"
			@update:open="showCancel = $event"
		/>
	</div>
</template>
