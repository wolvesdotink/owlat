<script setup lang="ts">
/**
 * The transactional editor's send options below the canvas. The unsubscribe
 * footer is part of the draft and saves with it. The other two change what the
 * send API accepts rather than what the email says, so they apply at once,
 * also while the email is published: which variables a caller may leave out
 * (`transactional/sendOptions.ts` `setVariableOptional`) and whether the
 * template is held to the per-recipient send limit (`setRecipientCapExempt`).
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';

const props = defineProps<{
	emailId: Id<'transactionalEmails'>;
	/** The template's declared data variables. */
	variables: ReadonlyArray<{ key: string; type: string }>;
	optionalVariables: readonly string[];
	isRecipientCapExempt: boolean;
}>();

const showUnsubscribe = defineModel<boolean>('showUnsubscribe', { required: true });

const { t } = useI18n();
const { isAdmin: canManage } = usePermissions();

const { run: setVariableOptional } = useBackendOperation(
	api.transactional.sendOptions.setVariableOptional,
	{ label: () => t('components.transactional.sendOptions.operations.variable') }
);
const { run: setRecipientCapExempt } = useBackendOperation(
	api.transactional.sendOptions.setRecipientCapExempt,
	{ label: () => t('components.transactional.sendOptions.operations.recipientLimit') }
);

const optional = computed(() => new Set(props.optionalVariables));

async function toggleOptional(key: string, isOptional: boolean) {
	await setVariableOptional({ id: props.emailId, key, isOptional });
}

async function toggleExempt(isExempt: boolean) {
	await setRecipientCapExempt({ id: props.emailId, isExempt });
}
</script>

<template>
	<div>
		<!-- Unsubscribe footer: sends append a Manage Preferences / Unsubscribe
		     footer built per recipient. Off by default: most transactional mail
		     is exempt. -->
		<div
			class="mt-3 rounded-lg shadow-surface-1 bg-bg-elevated px-10 py-5 flex items-center justify-between gap-4"
		>
			<div>
				<p class="text-base font-medium text-text-primary">
					{{ t('dashboard.send.transactional.detail.edit.unsubscribe.title') }}
				</p>
				<p class="text-sm text-text-tertiary mt-0.5">
					{{ t('dashboard.send.transactional.detail.edit.unsubscribe.description') }}
				</p>
			</div>
			<UiSwitch
				v-model="showUnsubscribe"
				:label="t('dashboard.send.transactional.detail.edit.unsubscribe.title')"
				class="shrink-0"
			/>
		</div>

		<section
			class="mt-3 rounded-lg shadow-surface-1 bg-bg-elevated px-10 py-5"
			data-testid="transactional-send-options"
		>
			<h2 class="text-base font-medium text-text-primary">
				{{ t('components.transactional.sendOptions.title') }}
			</h2>
			<p class="text-sm text-text-tertiary mt-0.5">
				{{ t('components.transactional.sendOptions.description') }}
			</p>

			<h3 class="text-sm font-medium text-text-primary mt-5">
				{{ t('components.transactional.sendOptions.variables.title') }}
			</h3>
			<p class="text-sm text-text-tertiary mt-0.5">
				{{ t('components.transactional.sendOptions.variables.description') }}
			</p>
			<ul v-if="variables.length > 0" class="mt-3 divide-y divide-border-subtle">
				<li
					v-for="variable in variables"
					:key="variable.key"
					class="flex items-center justify-between gap-4 py-2"
				>
					<div class="min-w-0">
						<code class="text-sm font-mono text-text-primary">{{ variable.key }}</code>
						<span class="ml-2 text-xs text-text-tertiary">{{ variable.type }}</span>
					</div>
					<div class="flex items-center gap-3 shrink-0">
						<span
							class="text-sm text-text-secondary"
							:data-testid="`variable-state-${variable.key}`"
						>
							{{
								optional.has(variable.key)
									? t('components.transactional.sendOptions.variables.optional')
									: t('components.transactional.sendOptions.variables.required')
							}}
						</span>
						<UiSwitch
							:model-value="optional.has(variable.key)"
							:disabled="!canManage"
							:label="
								t('components.transactional.sendOptions.variables.toggle', { name: variable.key })
							"
							:data-testid="`variable-optional-${variable.key}`"
							@update:model-value="toggleOptional(variable.key, $event)"
						/>
					</div>
				</li>
			</ul>
			<p v-else class="mt-3 text-sm text-text-tertiary">
				{{ t('components.transactional.sendOptions.variables.empty') }}
			</p>

			<div class="mt-5 flex items-center justify-between gap-4">
				<div>
					<h3 class="text-sm font-medium text-text-primary">
						{{ t('components.transactional.sendOptions.recipientLimit.title') }}
					</h3>
					<p class="text-sm text-text-tertiary mt-0.5">
						{{ t('components.transactional.sendOptions.recipientLimit.description') }}
					</p>
				</div>
				<UiSwitch
					:model-value="isRecipientCapExempt"
					:disabled="!canManage"
					:label="t('components.transactional.sendOptions.recipientLimit.title')"
					class="shrink-0"
					data-testid="recipient-limit-exempt"
					@update:model-value="toggleExempt"
				/>
			</div>
		</section>
	</div>
</template>
