<script setup lang="ts">
/**
 * Natural-language handling rules — inspect / add / revoke.
 *
 * The user teaches the assistant a standing instruction in plain English
 * ("always decline cold recruiter pitches"). A cheap LLM compiles it once
 * (mail.handlingRulesCompile.compile) into a deterministic matcher + action,
 * which is then persisted (mail.handlingRules.create). Rules can only ever
 * RESTRICT auto-send (draft-only / never-auto-send / always-ask / auto-archive)
 * or force a category — never widen auto-send. Every rule is listed here and
 * revocable.
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const { t } = useI18n();

const { data: rules, isLoading } = useConvexQuery(api.mail.handlingRules.list, () => ({}));

const compileOp = useBackendOperation(api.mail.handlingRulesCompile.compile, {
	label: () => t('components.autonomy.handlingRulesManager.compileOperation'),
	type: 'action',
});
const createOp = useBackendOperation(api.mail.handlingRules.create, {
	label: () => t('components.autonomy.handlingRulesManager.saveOperation'),
	type: 'mutation',
});
const removeOp = useBackendOperation(api.mail.handlingRules.remove, {
	label: () => t('components.autonomy.handlingRulesManager.deleteOperation'),
	type: 'mutation',
});
const toggleOp = useBackendOperation(api.mail.handlingRules.update, {
	label: () => t('components.autonomy.handlingRulesManager.updateOperation'),
	type: 'mutation',
});

const instruction = ref('');
const busy = computed(() => compileOp.isLoading.value || createOp.isLoading.value);

async function teachRule() {
	const text = instruction.value.trim();
	if (!text || busy.value) return;
	const compiled = await compileOp.run({ instruction: text });
	if (!compiled.ok) return; // errors are surfaced by useBackendOperation
	await createOp.run({
		instruction: text,
		matcher: compiled.result.matcher,
		action: compiled.result.action,
		compiledModel: compiled.result.compiledModel,
	});
	instruction.value = '';
}

async function remove(ruleId: Id<'handlingRules'>) {
	await removeOp.run({ ruleId });
}

async function toggle(ruleId: Id<'handlingRules'>, isEnabled: boolean) {
	await toggleOp.run({ ruleId, isEnabled });
}

/** Compiled action type → its catalog key; an unknown type falls back to itself. */
const ACTION_LABEL_KEYS: Record<string, string> = {
	draft_with_stance: 'components.autonomy.handlingRulesManager.actions.draftWithStance',
	categorize: 'components.autonomy.handlingRulesManager.actions.categorize',
	auto_archive: 'components.autonomy.handlingRulesManager.actions.autoArchive',
	always_ask: 'components.autonomy.handlingRulesManager.actions.alwaysAsk',
	never_auto_send: 'components.autonomy.handlingRulesManager.actions.neverAutoSend',
};

function actionLabel(type: string): string {
	const key = ACTION_LABEL_KEYS[type];
	return key ? t(key) : type;
}

function matcherSummary(matcher: {
	senders?: string[];
	subjectContains?: string[];
	bodyContains?: string[];
	categories?: string[];
}): string {
	const parts: string[] = [];
	const prefix = 'components.autonomy.handlingRulesManager.matcher';
	if (matcher.senders?.length)
		parts.push(t(`${prefix}.senders`, { senders: matcher.senders.join(', ') }));
	if (matcher.subjectContains?.length)
		parts.push(t(`${prefix}.subject`, { terms: matcher.subjectContains.join(', ') }));
	if (matcher.bodyContains?.length)
		parts.push(t(`${prefix}.body`, { terms: matcher.bodyContains.join(', ') }));
	if (matcher.categories?.length)
		parts.push(t(`${prefix}.categories`, { categories: matcher.categories.join(', ') }));
	return parts.join(' · ');
}
</script>

<template>
	<section class="space-y-3">
		<div>
			<h2 class="text-sm font-semibold text-text-primary">
				{{ t('components.autonomy.handlingRulesManager.title') }}
			</h2>
			<p class="text-xs text-text-secondary">
				{{ t('components.autonomy.handlingRulesManager.intro') }}
			</p>
		</div>

		<form class="flex items-start gap-2" @submit.prevent="teachRule">
			<input
				v-model="instruction"
				type="text"
				:placeholder="t('components.autonomy.handlingRulesManager.instructionPlaceholder')"
				class="input input-sm flex-1"
				:disabled="busy"
				:aria-label="t('components.autonomy.handlingRulesManager.instructionLabel')"
			/>
			<UiButton type="submit" variant="outline" size="sm" :disabled="busy || !instruction.trim()">
				<template #iconLeft>
					<Icon
						:name="busy ? 'lucide:loader-2' : 'lucide:sparkles'"
						class="w-4 h-4"
						:class="{ 'animate-spin motion-reduce:animate-none': busy }"
					/>
				</template>
				{{ t('components.autonomy.handlingRulesManager.teach') }}
			</UiButton>
		</form>
		<p v-if="compileOp.inlineError.value" class="text-xs text-error">
			{{ compileOp.inlineError.value }}
		</p>

		<div v-if="isLoading" class="text-xs text-text-secondary">
			{{ t('components.autonomy.handlingRulesManager.loading') }}
		</div>
		<ul v-else-if="rules && rules.length" class="space-y-2">
			<li
				v-for="rule in rules"
				:key="rule._id"
				class="flex items-start justify-between gap-3 p-2.5 rounded-md bg-surface-2 shadow-surface-1"
				:class="{ 'opacity-60': !rule.isEnabled }"
			>
				<div class="min-w-0">
					<p class="text-sm text-text-primary truncate">{{ rule.instruction }}</p>
					<p class="text-xs text-text-secondary">
						<span class="font-medium">{{ actionLabel(rule.action.type) }}</span>
						<template v-if="rule.action.stance"> · “{{ rule.action.stance }}”</template>
						<template v-if="rule.action.category"> · {{ rule.action.category }}</template>
						<template v-if="matcherSummary(rule.matcher)">
							— {{ matcherSummary(rule.matcher) }}</template
						>
					</p>
				</div>
				<div class="flex items-center gap-2 shrink-0">
					<button
						type="button"
						class="text-xs text-text-secondary hover:text-text-primary"
						@click="toggle(rule._id, !rule.isEnabled)"
					>
						{{
							rule.isEnabled
								? t('components.autonomy.handlingRulesManager.disable')
								: t('components.autonomy.handlingRulesManager.enable')
						}}
					</button>
					<button
						type="button"
						class="text-xs text-error hover:underline"
						:aria-label="t('components.autonomy.handlingRulesManager.deleteRule')"
						@click="remove(rule._id)"
					>
						{{ t('common.delete') }}
					</button>
				</div>
			</li>
		</ul>
		<p v-else class="text-xs text-text-secondary">
			{{ t('components.autonomy.handlingRulesManager.emptyState') }}
		</p>
	</section>
</template>
