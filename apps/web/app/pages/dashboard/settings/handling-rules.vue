<script setup lang="ts">
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
	// Only reachable when AI features are enabled (compilation needs the LLM).
	requiresFeature: 'ai',
});

useHead({ title: 'Handling Rules — Owlat' });

const {
	data: rules,
	isLoading: rulesLoading,
	error: rulesError,
} = useConvexQuery(api.mail.handlingRules.list, () => ({}));

const { run: createRule, isLoading: creating } = useBackendOperation(api.mail.handlingRules.create, {
	label: 'Create handling rule',
});
const { run: updateRule } = useBackendOperation(api.mail.handlingRules.update, {
	label: 'Update handling rule',
});
const { run: removeRule } = useBackendOperation(api.mail.handlingRules.remove, {
	label: 'Delete handling rule',
});

const { showToast: displayToast } = useToast();

const draft = ref('');

const examples = [
	'Draft a polite decline for recruiters.',
	'Flag anything from legal for me — never auto-send.',
	'Auto-archive newsletters and marketing blasts.',
	'Always ask me before replying to anyone at bigclient.com.',
];

async function submitNew() {
	const text = draft.value.trim();
	if (!text) return;
	const result = await createRule({ naturalLanguage: text });
	if (result === undefined) return;
	draft.value = '';
	displayToast('Rule saved — compiling…');
}

async function toggleEnabled(rule: { _id: string; isEnabled: boolean }) {
	const result = await updateRule({
		ruleId: rule._id as Id<'handlingRules'>,
		isEnabled: !rule.isEnabled,
	});
	if (result === undefined) return;
	displayToast(rule.isEnabled ? 'Rule paused' : 'Rule enabled');
}

async function deleteRule(ruleId: string) {
	const result = await removeRule({ ruleId: ruleId as Id<'handlingRules'> });
	if (result === undefined) return;
	displayToast('Rule deleted');
}

function statusLabel(status: string): string {
	if (status === 'active') return 'Active';
	if (status === 'compiling') return 'Compiling…';
	return 'Failed';
}

function actionLabel(action?: string): string {
	switch (action) {
		case 'draft_with_stance':
			return 'Draft (never auto-send)';
		case 'categorize':
			return 'Categorize';
		case 'auto_archive':
			return 'Auto-archive';
		case 'always_ask':
			return 'Always ask me';
		case 'never_auto_send':
			return 'Never auto-send';
		default:
			return '—';
	}
}
</script>

<template>
	<div class="p-6 lg:p-8">
		<NuxtLink
			to="/dashboard/settings"
			class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-6"
		>
			<Icon name="lucide:arrow-left" class="w-4 h-4" />
			Back to Settings
		</NuxtLink>

		<div class="flex items-center gap-4 mb-8">
			<UiIconBox icon="lucide:wand-sparkles" size="xl" variant="brand" rounded="full" />
			<div>
				<h1 class="text-2xl font-semibold text-text-primary">Handling Rules</h1>
				<p class="text-text-secondary mt-1 max-w-xl">
					Teach the assistant in plain English how to handle certain mail. A rule can only ever
					make the agent <em>more</em> cautious — it can hold a reply for your review or archive
					mail, but it can never widen what gets auto-sent.
				</p>
			</div>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
			<div class="lg:col-span-2 space-y-4">
				<!-- New rule -->
				<UiCard>
					<label class="block text-sm font-medium text-text-primary mb-2">
						Add a rule
					</label>
					<textarea
						v-model="draft"
						rows="2"
						placeholder="e.g. Draft a polite decline for recruiters"
						class="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
						@keydown.meta.enter="submitNew"
					/>
					<div class="flex items-center justify-between mt-3">
						<p class="text-xs text-text-tertiary">
							We compile your rule into a matcher you can inspect below.
						</p>
						<button
							class="btn btn-primary gap-2"
							:disabled="creating || !draft.trim()"
							@click="submitNew"
						>
							<Icon name="lucide:plus" class="w-4 h-4" />
							Add rule
						</button>
					</div>
				</UiCard>

				<div v-if="rulesLoading" class="flex items-center justify-center py-16">
					<div class="flex flex-col items-center gap-3">
						<UiSpinner />
						<p class="text-text-secondary text-sm">Loading rules…</p>
					</div>
				</div>

				<UiErrorAlert
					v-else-if="rulesError"
					title="Couldn't load handling rules"
					message="We hit an error loading your rules. Reload to try again."
					class="my-8"
				/>

				<template v-else>
					<UiCard v-for="rule in rules" :key="rule._id">
						<div class="flex items-start justify-between gap-4">
							<div class="min-w-0">
								<p class="text-sm text-text-primary" :class="{ 'opacity-60': !rule.isEnabled }">
									{{ rule.naturalLanguage }}
								</p>
								<div class="flex flex-wrap items-center gap-2 mt-2 text-xs">
									<span
										class="px-2 py-0.5 rounded-full"
										:class="{
											'bg-brand-subtle text-brand': rule.status === 'active',
											'bg-surface-secondary text-text-tertiary': rule.status === 'compiling',
											'bg-danger-subtle text-danger': rule.status === 'failed',
										}"
									>
										{{ statusLabel(rule.status) }}
									</span>
									<span v-if="rule.status === 'active'" class="text-text-tertiary">
										{{ actionLabel(rule.action) }}
									</span>
									<span v-if="!rule.isEnabled" class="text-text-tertiary">· Paused</span>
								</div>
								<p v-if="rule.status === 'failed' && rule.compileError" class="text-xs text-danger mt-2">
									{{ rule.compileError }}
								</p>
								<div
									v-if="rule.status === 'active' && rule.matcher"
									class="text-xs text-text-tertiary mt-2 space-y-0.5"
								>
									<p v-for="(c, i) in rule.matcher.conditions" :key="i">
										when <b>{{ c.field }}</b> {{ c.op }} “{{ c.value }}”
									</p>
								</div>
							</div>
							<div class="flex items-center gap-2 shrink-0">
								<button
									class="btn btn-ghost btn-sm"
									:title="rule.isEnabled ? 'Pause' : 'Enable'"
									@click="toggleEnabled(rule)"
								>
									<Icon :name="rule.isEnabled ? 'lucide:pause' : 'lucide:play'" class="w-4 h-4" />
								</button>
								<button
									class="btn btn-ghost btn-sm text-danger"
									title="Delete"
									@click="deleteRule(rule._id)"
								>
									<Icon name="lucide:trash-2" class="w-4 h-4" />
								</button>
							</div>
						</div>
					</UiCard>

					<UiCard v-if="!rules?.length">
						<div class="py-8 text-center">
							<UiIconBox icon="lucide:wand-sparkles" size="lg" variant="surface" class="mx-auto mb-4" />
							<h3 class="text-base font-medium text-text-primary mb-2">No handling rules yet</h3>
							<p class="text-sm text-text-tertiary max-w-sm mx-auto">
								Add a rule above to teach the assistant standing intent in plain English.
							</p>
						</div>
					</UiCard>
				</template>
			</div>

			<div class="space-y-4">
				<UiCard>
					<div class="flex items-center gap-3 mb-4">
						<UiIconBox icon="lucide:lightbulb" size="sm" variant="surface" />
						<h3 class="text-base font-medium text-text-primary">Examples</h3>
					</div>
					<ul class="space-y-2 text-sm text-text-secondary">
						<li v-for="ex in examples" :key="ex" class="flex gap-2">
							<Icon name="lucide:corner-down-right" class="w-4 h-4 mt-0.5 shrink-0 text-text-tertiary" />
							<button class="text-left hover:text-text-primary" @click="draft = ex">{{ ex }}</button>
						</li>
					</ul>
				</UiCard>

				<UiCard>
					<div class="flex items-center gap-3 mb-4">
						<UiIconBox icon="lucide:shield-check" size="sm" variant="surface" />
						<h3 class="text-base font-medium text-text-primary">Safety</h3>
					</div>
					<p class="text-sm text-text-secondary">
						Rules are compiled into a deterministic matcher run on every inbound message. A rule can
						only <b>restrict</b> automation — hold a reply for review, archive, or categorize. It can
						never cause the agent to auto-send something it otherwise wouldn't.
					</p>
				</UiCard>
			</div>
		</div>
	</div>
</template>
