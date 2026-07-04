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

const { data: rules, isLoading } = useConvexQuery(api.mail.handlingRules.list, () => ({}));

const compileOp = useBackendOperation(api.mail.handlingRulesCompile.compile, {
	label: 'Compile rule',
	type: 'action',
});
const createOp = useBackendOperation(api.mail.handlingRules.create, {
	label: 'Save rule',
	type: 'mutation',
});
const removeOp = useBackendOperation(api.mail.handlingRules.remove, {
	label: 'Delete rule',
	type: 'mutation',
});
const toggleOp = useBackendOperation(api.mail.handlingRules.update, {
	label: 'Update rule',
	type: 'mutation',
});

const instruction = ref('');
const busy = computed(() => compileOp.isLoading.value || createOp.isLoading.value);

async function teachRule() {
	const text = instruction.value.trim();
	if (!text || busy.value) return;
	const compiled = await compileOp.run({ instruction: text });
	if (!compiled) return; // errors are surfaced by useBackendOperation
	await createOp.run({
		instruction: text,
		matcher: compiled.matcher,
		action: compiled.action,
		compiledModel: compiled.compiledModel,
	});
	instruction.value = '';
}

async function remove(ruleId: Id<'handlingRules'>) {
	await removeOp.run({ ruleId });
}

async function toggle(ruleId: Id<'handlingRules'>, isEnabled: boolean) {
	await toggleOp.run({ ruleId, isEnabled });
}

const ACTION_LABELS: Record<string, string> = {
	draft_with_stance: 'Draft only',
	categorize: 'Categorize',
	auto_archive: 'Auto-archive',
	always_ask: 'Always ask',
	never_auto_send: 'Never auto-send',
};

function matcherSummary(matcher: {
	senders?: string[];
	subjectContains?: string[];
	bodyContains?: string[];
	categories?: string[];
}): string {
	const parts: string[] = [];
	if (matcher.senders?.length) parts.push(`from ${matcher.senders.join(', ')}`);
	if (matcher.subjectContains?.length) parts.push(`subject ~ ${matcher.subjectContains.join(', ')}`);
	if (matcher.bodyContains?.length) parts.push(`body ~ ${matcher.bodyContains.join(', ')}`);
	if (matcher.categories?.length) parts.push(`category: ${matcher.categories.join(', ')}`);
	return parts.join(' · ');
}
</script>

<template>
	<section class="space-y-3">
		<div>
			<h2 class="text-sm font-semibold text-text-primary">Natural-language rules</h2>
			<p class="text-xs text-text-secondary">
				Teach the assistant standing intent in plain English. A rule can hold mail for review,
				pre-draft a stance, categorize, or auto-archive — it can only ever restrict auto-send,
				never widen it.
			</p>
		</div>

		<form class="flex items-start gap-2" @submit.prevent="teachRule">
			<input
				v-model="instruction"
				type="text"
				placeholder="e.g. always draft a polite decline for recruiters"
				class="flex-1 px-2.5 py-1.5 rounded-md border border-border-subtle bg-bg-surface text-sm text-text-primary placeholder:text-text-tertiary"
				:disabled="busy"
				aria-label="New handling rule"
			/>
			<button
				type="submit"
				class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-surface disabled:opacity-50"
				:disabled="busy || !instruction.trim()"
			>
				<Icon
					:name="busy ? 'lucide:loader-2' : 'lucide:sparkles'"
					class="w-4 h-4"
					:class="{ 'animate-spin': busy }"
				/>
				Teach rule
			</button>
		</form>
		<p v-if="compileOp.inlineError.value" class="text-xs text-error">
			{{ compileOp.inlineError.value }}
		</p>

		<div v-if="isLoading" class="text-xs text-text-secondary">Loading rules…</div>
		<ul v-else-if="rules && rules.length" class="space-y-2">
			<li
				v-for="rule in rules"
				:key="rule._id"
				class="flex items-start justify-between gap-3 p-2.5 rounded-md border border-border-subtle"
				:class="{ 'opacity-60': !rule.isEnabled }"
			>
				<div class="min-w-0">
					<p class="text-sm text-text-primary truncate">{{ rule.instruction }}</p>
					<p class="text-xs text-text-secondary">
						<span class="font-medium">{{ ACTION_LABELS[rule.action.type] ?? rule.action.type }}</span>
						<template v-if="rule.action.stance"> · “{{ rule.action.stance }}”</template>
						<template v-if="rule.action.category"> · {{ rule.action.category }}</template>
						<template v-if="matcherSummary(rule.matcher)"> — {{ matcherSummary(rule.matcher) }}</template>
					</p>
				</div>
				<div class="flex items-center gap-2 shrink-0">
					<button
						type="button"
						class="text-xs text-text-secondary hover:text-text-primary"
						@click="toggle(rule._id, !rule.isEnabled)"
					>
						{{ rule.isEnabled ? 'Disable' : 'Enable' }}
					</button>
					<button
						type="button"
						class="text-xs text-error hover:underline"
						aria-label="Delete rule"
						@click="remove(rule._id)"
					>
						Delete
					</button>
				</div>
			</li>
		</ul>
		<p v-else class="text-xs text-text-secondary">No rules yet.</p>
	</section>
</template>
