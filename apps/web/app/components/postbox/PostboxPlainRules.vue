<script setup lang="ts">
/**
 * Rules in your words (read on arrival, SPEC §6.1, §6.2): the section at the
 * top of the Filters page. The person writes a sentence; Owlat compiles it
 * into a rule they check before it is saved. Rules that need judgement carry
 * one AI question, answered once per message as it arrives. Every rule can be
 * tested on the last 50 Inbox mails. Below the list, the opt-in "archive codes
 * and sign-in links after a day".
 *
 * A rule only restricts: it labels, files, flags, places in Updates or the
 * digest, archives later or notifies. It never forwards, deletes or replies.
 */

import type { Doc, Id } from '@owlat/api/dataModel';
import type { FilterAction, MailFilterCondition } from '~/composables/postbox/usePostboxFilters';
import {
	isPlainLanguageRule,
	usePostboxRules,
	type RuleDraftRow,
	type RuleDryRunResult,
} from '~/composables/postbox/usePostboxRules';

const props = defineProps<{
	mailboxId: Id<'mailboxes'>;
	filters: Doc<'mailFilters'>[];
}>();

const emit = defineEmits<{
	(e: 'toggle', filterId: Id<'mailFilters'>, isEnabled: boolean): void;
	(e: 'remove', filterId: Id<'mailFilters'>): void;
}>();

const { t } = useI18n();
const mailboxIdRef = computed<Id<'mailboxes'> | null>(() => props.mailboxId);
const { drafts, compile, confirm, discard, test, isCompiling, isTesting } =
	usePostboxRules(mailboxIdRef);
const { folders } = usePostboxFolders(mailboxIdRef);
const { labels } = usePostboxLabels(mailboxIdRef);
const { codeAutoArchive, setCodeAutoArchive } = usePostboxSettings();

const rules = computed(() => props.filters.filter((filter) => isPlainLanguageRule(filter)));

function folderName(id: Id<'mailFolders'>): string | undefined {
	return folders.value.find((folder) => folder._id === id)?.name;
}
function labelName(id: Id<'mailLabels'>): string | undefined {
	return labels.value.find((label) => label._id === id)?.name;
}

const text = ref('');
async function add() {
	const value = text.value.trim();
	if (!value || isCompiling.value) return;
	text.value = '';
	if (!(await compile(value))) text.value = value;
}

const dryRun = ref<{ key: string; result: RuleDryRunResult } | null>(null);
async function testDraft(draft: RuleDraftRow) {
	if (!draft.preview) return;
	const result = await test({
		draft: {
			conditions: draft.preview.conditions as MailFilterCondition[],
			...(draft.preview.matchType ? { matchType: draft.preview.matchType } : {}),
			...(draft.preview.aiCondition ? { aiQuestion: draft.preview.aiCondition.question } : {}),
		},
	});
	if (result) dryRun.value = { key: draft._id, result };
}
async function testRule(filterId: Id<'mailFilters'>) {
	const result = await test({ filterId });
	if (result) dryRun.value = { key: filterId, result };
}
</script>

<template>
	<section class="card mb-6 p-5">
		<header class="mb-3">
			<h2 class="font-semibold">{{ t('postbox.rules.title') }}</h2>
			<p class="mt-1 text-sm text-text-secondary">{{ t('postbox.rules.intro') }}</p>
		</header>

		<form class="flex items-center gap-2" @submit.prevent="add">
			<UiInput
				v-model="text"
				class="flex-1"
				:placeholder="t('postbox.rules.placeholder')"
				:aria-label="t('postbox.rules.inputLabel')"
				maxlength="500"
			/>
			<UiButton type="submit" variant="outline" :disabled="!text.trim() || isCompiling">
				{{ t('postbox.rules.add') }}
			</UiButton>
		</form>

		<ul v-if="drafts.length > 0" class="mt-3 space-y-2">
			<li
				v-for="draft in drafts"
				:key="draft._id"
				class="rounded-lg border border-border-subtle bg-bg-surface p-3"
			>
				<p class="text-xs text-text-tertiary">“{{ draft.sourceText }}”</p>
				<p
					v-if="draft.status === 'compiling'"
					class="mt-1 flex items-center gap-2 text-sm text-text-secondary"
				>
					<UiSpinner size="sm" /> {{ t('postbox.rules.compiling') }}
				</p>
				<template v-else-if="draft.status === 'ready' && draft.preview">
					<p class="mt-1 text-sm font-medium">{{ draft.preview.name }}</p>
					<PostboxRuleChips
						class="mt-1.5"
						:conditions="draft.preview.conditions as MailFilterCondition[]"
						:match-type="draft.preview.matchType"
						:ai-question="draft.preview.aiCondition?.question"
						:actions="draft.preview.actions as FilterAction[]"
						:folder-name="folderName"
						:label-name="labelName"
					/>
					<div class="mt-2 flex flex-wrap items-center justify-end gap-2">
						<UiButton
							variant="ghost"
							size="sm"
							type="button"
							:disabled="isTesting"
							@click="testDraft(draft)"
						>
							{{ t('postbox.rules.test') }}
						</UiButton>
						<UiButton variant="ghost" size="sm" type="button" @click="discard(draft._id)">
							{{ t('postbox.rules.discard') }}
						</UiButton>
						<UiButton size="sm" type="button" @click="confirm(draft._id)">
							{{ t('postbox.rules.save') }}
						</UiButton>
					</div>
				</template>
				<div v-else class="mt-1 flex items-center justify-between gap-3">
					<p class="text-sm text-text-secondary">{{ t('postbox.rules.failed') }}</p>
					<UiButton variant="ghost" size="sm" type="button" @click="discard(draft._id)">
						{{ t('postbox.rules.discard') }}
					</UiButton>
				</div>
				<PostboxRuleDryRun
					v-if="dryRun?.key === draft._id"
					class="mt-3"
					:result="dryRun.result"
					@close="dryRun = null"
				/>
			</li>
		</ul>

		<p v-if="rules.length === 0 && drafts.length === 0" class="mt-3 text-sm text-text-secondary">
			{{ t('postbox.rules.empty') }}
		</p>
		<ul v-else-if="rules.length > 0" class="mt-3 divide-y divide-border-subtle">
			<li v-for="rule in rules" :key="rule._id" class="py-3">
				<div class="flex items-start gap-3">
					<UiSwitch
						class="mt-0.5"
						:model-value="rule.isEnabled"
						:label="`${t('common.enabled')}: ${rule.name}`"
						@update:model-value="(on: boolean) => emit('toggle', rule._id, on)"
					/>
					<div class="min-w-0 flex-1">
						<p class="text-sm font-medium">{{ rule.name }}</p>
						<p v-if="rule.sourceText" class="text-xs text-text-tertiary">“{{ rule.sourceText }}”</p>
						<PostboxRuleChips
							class="mt-1.5"
							:conditions="rule.conditions as MailFilterCondition[]"
							:match-type="rule.matchType"
							:ai-question="rule.aiCondition?.question"
							:actions="rule.actions as FilterAction[]"
							:folder-name="folderName"
							:label-name="labelName"
						/>
						<p v-if="rule.aiCondition" class="mt-1 text-xs text-text-tertiary">
							{{ t('postbox.rules.aiNote') }}
						</p>
					</div>
					<UiButton
						variant="ghost"
						size="sm"
						type="button"
						:disabled="isTesting"
						@click="testRule(rule._id)"
					>
						{{ t('postbox.rules.test') }}
					</UiButton>
					<UiButton
						variant="ghost"
						size="sm"
						type="button"
						class="text-error"
						@click="emit('remove', rule._id)"
					>
						{{ t('common.delete') }}
					</UiButton>
				</div>
				<PostboxRuleDryRun
					v-if="dryRun?.key === rule._id"
					class="mt-3"
					:result="dryRun.result"
					@close="dryRun = null"
				/>
			</li>
		</ul>

		<div class="mt-4 flex items-start gap-3 border-t border-border-subtle pt-4">
			<UiSwitch
				class="mt-0.5"
				:model-value="codeAutoArchive"
				:label="t('postbox.rules.codes.label')"
				@update:model-value="(on: boolean) => setCodeAutoArchive(on)"
			/>
			<div>
				<p class="text-sm font-medium">{{ t('postbox.rules.codes.label') }}</p>
				<p class="text-xs text-text-secondary">{{ t('postbox.rules.codes.help') }}</p>
			</div>
		</div>
	</section>
</template>
