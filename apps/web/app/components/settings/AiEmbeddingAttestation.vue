<script setup lang="ts">
/**
 * Attest which embedder wrote the vectors from before provenance (U1, D8,
 * #1334). Owlat kept no record of that, so a vector from before provenance is
 * out of vector search until it is re-embedded, or an admin states, as an
 * attestation, that the configured embedder wrote it. The statement is the
 * admin's: the form says so, asks what it rests on, and needs an explicit
 * confirmation. A wrong attestation mixes vectors of two models and makes
 * search worse, so re-embedding stays the default answer.
 *
 * Offered for a hosted embedder only: a local one re-embeds for free, and its
 * measured identity carries a digest an attestation cannot state. Recorded
 * attestations are listed with their state, and each can be revoked, which
 * returns its rows to unknown.
 */
import { computed, ref, watch } from 'vue';
import type { useEmbeddingSpaces } from '~/composables/useEmbeddingSpaces';
import {
	attestationBlocker,
	attestationIdentity,
	attestationSubject,
	cohortEnd,
	isAttestationOffered,
	unknownRows,
	type EmbeddingStatus,
} from '~/utils/embeddingSpaces';
import { formatDate, formatDateTime, formatNumber } from '~/utils/formatters';
import { embeddingProviderMeta } from '~/utils/aiProviders';

const props = defineProps<{
	spaces: ReturnType<typeof useEmbeddingSpaces>;
	status: EmbeddingStatus;
}>();

const { t } = useI18n();
const K = 'dashboard.admin.instance.aiProvider.embeddingSpace.attest';
const STATEMENT_MAX = 2000;

const subject = computed(() => attestationSubject(props.status));
const isOffered = computed(() => isAttestationOffered(props.status));
/** The server would refuse it (the space is not where the old vectors are). */
const blocker = computed(() => attestationBlocker(props.status));
const unknown = computed(() => unknownRows(props.status.coverage));

const today = () => {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const source = ref<'attestation' | 'record'>('attestation');
const writtenBefore = ref(today());
const suggestedWidth = () =>
	subject.value?.kind === 'identity' ? String(subject.value.suggestedDimensions ?? '') : '';
const dimensions = ref(suggestedWidth());
const statement = ref('');

/**
 * The confirmation is given to ONE statement: this space or identity, this
 * period, this width, this basis. It is stored with that statement's key and
 * counts only while the form still says exactly that, so a settings change by
 * another admin (a new configured model arriving through the subscription),
 * or an edit of the period or the width, takes it back at once.
 */
const subjectKey = computed(() => JSON.stringify(subject.value));
const consentKey = computed(() =>
	JSON.stringify([subjectKey.value, writtenBefore.value, dimensions.value.trim(), source.value])
);
const confirmedKey = ref<string | null>(null);
const isConfirmed = computed({
	get: () => confirmedKey.value !== null && confirmedKey.value === consentKey.value,
	set: (value: boolean) => {
		confirmedKey.value = value ? consentKey.value : null;
	},
});
// Another subject: its own suggested width, and no confirmation carried over.
watch(subjectKey, () => {
	dimensions.value = suggestedWidth();
	confirmedKey.value = null;
});

const sourceOptions = computed(() => [
	{ value: 'attestation', label: t(`${K}.sources.attestation`) },
	{ value: 'record', label: t(`${K}.sources.record`) },
]);

const width = computed(() => {
	const value = Number(dimensions.value.trim());
	return Number.isInteger(value) && value >= 1 ? value : null;
});
/**
 * Everything the attestation assigns (D8): the admin states all of it, for
 * the whole period, not only the model name.
 */
const identity = computed(() => attestationIdentity(props.status, width.value));
const providerLabel = computed(() => {
	const meta = identity.value ? embeddingProviderMeta(identity.value.provider) : undefined;
	return meta ? t(meta.label) : (identity.value?.provider ?? '');
});
/** The chosen day, as the confirmation names it. */
const periodEnd = computed(() => {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(writtenBefore.value);
	return match
		? formatDate(new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])), 'long')
		: '';
});
const confirmLabel = computed(() =>
	t(identity.value?.revision ? `${K}.confirmWithRevision` : `${K}.confirm`, {
		date: periodEnd.value,
	})
);

const problems = computed(() => ({
	writtenBefore:
		cohortEnd(writtenBefore.value, Date.now()) === null ? t(`${K}.problems.date`) : null,
	dimensions:
		subject.value?.kind === 'identity' && width.value === null ? t(`${K}.problems.width`) : null,
	statement:
		statement.value.trim().length === 0 || statement.value.length > STATEMENT_MAX
			? t(`${K}.problems.statement`, { max: STATEMENT_MAX })
			: null,
}));
const canSubmit = computed(
	() =>
		subject.value !== null &&
		isConfirmed.value &&
		Object.values(problems.value).every((problem) => problem === null) &&
		!props.spaces.isBusy.value
);

async function submit() {
	const target = subject.value;
	const writtenUntil = cohortEnd(writtenBefore.value, Date.now());
	if (!canSubmit.value || !target || writtenUntil === null) return;
	const space =
		target.kind === 'space'
			? { spaceId: target.spaceId }
			: {
					identity: {
						provider: target.provider,
						endpoint: target.endpoint,
						model: target.model,
						dimensions: width.value!,
					},
				};
	const isDone = await props.spaces.attest({
		...space,
		source: source.value,
		cohort: { tables: ['knowledgeEntries', 'semanticFiles'], writtenUntil },
		statement: statement.value.trim(),
	});
	if (isDone) {
		statement.value = '';
		isConfirmed.value = false;
	}
}

const revoking = ref<EmbeddingStatus['attestations'][number] | null>(null);
async function confirmRevoke() {
	const attestation = revoking.value;
	if (attestation && (await props.spaces.revoke(attestation._id))) revoking.value = null;
}
</script>

<template>
	<section data-testid="ai-embedding-attestation">
		<h3 class="text-sm font-medium text-text-primary">{{ t(`${K}.title`) }}</h3>
		<p class="mt-1 text-xs text-text-tertiary">{{ t(`${K}.description`) }}</p>

		<p
			v-if="isOffered && subject && blocker"
			class="mt-3 rounded-lg border border-border-subtle p-3 text-sm text-text-secondary"
			data-testid="ai-embedding-attest-blocked"
		>
			{{ t(blocker) }}
		</p>
		<form
			v-else-if="isOffered && subject"
			class="mt-3 space-y-4 rounded-lg border border-border-subtle p-4"
			data-testid="ai-embedding-attest-form"
			@submit.prevent="submit"
		>
			<p class="text-sm text-text-primary">
				{{
					t(`${K}.subject`, {
						count: formatNumber(unknown),
					})
				}}
			</p>
			<div class="grid gap-4 sm:grid-cols-2">
				<UiSelect
					v-model="source"
					size="sm"
					:label="t(`${K}.sourceLabel`)"
					:options="sourceOptions"
					:disabled="spaces.isBusy.value"
				/>
				<UiInput
					v-model="writtenBefore"
					type="date"
					size="sm"
					:label="t(`${K}.writtenBeforeLabel`)"
					:help-text="t(`${K}.writtenBeforeHelp`)"
					:error="problems.writtenBefore ?? undefined"
					:disabled="spaces.isBusy.value"
				/>
				<UiInput
					v-if="subject.kind === 'identity'"
					v-model="dimensions"
					size="sm"
					inputmode="numeric"
					:label="t(`${K}.widthLabel`)"
					:help-text="t(`${K}.widthHelp`)"
					:error="problems.dimensions ?? undefined"
					:disabled="spaces.isBusy.value"
				/>
			</div>
			<div
				v-if="identity"
				class="rounded-lg bg-bg-surface-hover p-3 text-sm"
				data-testid="ai-embedding-attest-identity"
			>
				<p class="text-xs font-medium text-text-secondary">{{ t(`${K}.identity.title`) }}</p>
				<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
					<dt class="text-text-tertiary">{{ t(`${K}.identity.provider`) }}</dt>
					<dd class="text-text-primary">{{ providerLabel }}</dd>
					<dt class="text-text-tertiary">{{ t(`${K}.identity.endpoint`) }}</dt>
					<dd class="text-text-primary break-all">
						{{ identity.endpointOrigin ?? t(`${K}.identity.nativeEndpoint`) }}
					</dd>
					<dt class="text-text-tertiary">{{ t(`${K}.identity.model`) }}</dt>
					<dd class="font-mono text-text-primary">{{ identity.model }}</dd>
					<dt class="text-text-tertiary">{{ t(`${K}.identity.width`) }}</dt>
					<dd class="text-text-primary">
						{{
							identity.dimensions === null
								? t(`${K}.identity.widthMissing`)
								: t(`${K}.identity.widthValue`, { dimensions: identity.dimensions })
						}}
					</dd>
					<template v-if="identity.revision">
						<dt class="text-text-tertiary">{{ t(`${K}.identity.revision`) }}</dt>
						<dd class="font-mono text-text-primary break-all">{{ identity.revision }}</dd>
					</template>
				</dl>
			</div>
			<UiTextarea
				v-model="statement"
				:label="t(`${K}.statementLabel`)"
				:placeholder="t(`${K}.statementPlaceholder`)"
				:rows="3"
				:max-length="STATEMENT_MAX"
				:disabled="spaces.isBusy.value"
			/>
			<UiCheckbox v-model="isConfirmed" :disabled="spaces.isBusy.value" :label="confirmLabel" />
			<div class="flex flex-wrap items-center gap-3">
				<UiButton
					type="submit"
					variant="secondary"
					size="sm"
					:disabled="!canSubmit"
					data-testid="ai-embedding-attest-submit"
				>
					{{ t(`${K}.submit`) }}
				</UiButton>
				<p class="text-xs text-text-tertiary">{{ t(`${K}.warning`) }}</p>
			</div>
		</form>

		<ul
			v-if="status.attestations.length > 0"
			class="mt-3 space-y-2"
			data-testid="ai-embedding-attestations"
		>
			<li
				v-for="attestation in status.attestations"
				:key="attestation._id"
				class="flex flex-col gap-2 rounded-lg border border-border-subtle p-3 text-sm sm:flex-row sm:items-start sm:justify-between"
				:data-status="attestation.status"
			>
				<div class="min-w-0">
					<p class="text-text-primary font-medium">
						{{
							t(`${K}.entry.title`, {
								source: t(`${K}.sources.${attestation.source}`),
								date: formatDateTime(attestation.attestedAt),
							})
						}}
					</p>
					<p class="mt-0.5 text-text-secondary break-words">{{ attestation.statement }}</p>
					<p class="mt-0.5 text-xs text-text-tertiary">
						{{
							t(`${K}.entry.status.${attestation.status}`, {
								count: formatNumber(attestation.rowsAssigned),
								until: formatDateTime(attestation.cohort.writtenUntil),
							})
						}}
					</p>
				</div>
				<UiButton
					v-if="attestation.status !== 'revoked'"
					type="button"
					variant="ghost"
					size="sm"
					class="shrink-0"
					:disabled="spaces.isBusy.value"
					@click="revoking = attestation"
				>
					{{ t(`${K}.revoke`) }}
				</UiButton>
			</li>
		</ul>

		<UiConfirmationDialog
			:open="revoking !== null"
			variant="danger"
			:title="t(`${K}.revokeTitle`)"
			:description="t(`${K}.revokeBody`)"
			:confirm-text="t(`${K}.revoke`)"
			:is-loading="spaces.isBusy.value"
			@update:open="(open: boolean) => (revoking = open ? revoking : null)"
			@confirm="confirmRevoke"
		/>
	</section>
</template>
