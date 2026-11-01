<script setup lang="ts">
import type { Id } from '@owlat/api/dataModel';
import {
	CheckIcon,
	CircleCheckIcon,
	CopyIcon,
	ExternalLinkIcon,
	InboxIcon,
	TriangleWarningIcon,
} from '@coolicons/vue';

// The expanded body of one form endpoint card on the forms admin page:
// submission statistics, recent submissions, the endpoint URL and the embed
// code, each copyable. The page owns the clipboard and builds the URL and code.
defineProps<{
	form: { _id: Id<'formEndpoints'>; totalSubmissions: number; successfulSubmissions: number };
	formUrl: string;
	embedCode: string;
	/** Which copy button last succeeded (`url-<id>` / `embed-<id>`), for its check mark. */
	copiedCode: string | null;
}>();

const emit = defineEmits<{ copy: [text: string, codeType: string] }>();

const { t } = useI18n();
</script>

<template>
	<div class="border-t border-border-subtle">
		<div class="px-6 py-4 bg-bg-surface/30 space-y-6">
			<!-- Stats Section -->
			<div>
				<h4 class="text-sm font-medium text-text-primary mb-3">
					{{ t('dashboard.admin.instance.forms.stats.title') }}
				</h4>
				<div class="grid grid-cols-2 md:grid-cols-4 gap-4">
					<div class="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
						<div class="flex items-center gap-2 mb-1">
							<InboxIcon class="w-4 h-4 text-text-tertiary" />
							<span class="text-xs text-text-tertiary">{{
								t('dashboard.admin.instance.forms.stats.total')
							}}</span>
						</div>
						<p class="text-xl font-semibold text-text-primary">
							{{ form.totalSubmissions }}
						</p>
					</div>
					<div class="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
						<div class="flex items-center gap-2 mb-1">
							<CircleCheckIcon class="w-4 h-4 text-success" />
							<span class="text-xs text-text-tertiary">{{
								t('dashboard.admin.instance.forms.stats.successful')
							}}</span>
						</div>
						<p class="text-xl font-semibold text-success">
							{{ form.successfulSubmissions }}
						</p>
					</div>
					<div class="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
						<div class="flex items-center gap-2 mb-1">
							<TriangleWarningIcon class="w-4 h-4 text-warning" />
							<span class="text-xs text-text-tertiary">{{
								t('dashboard.admin.instance.forms.stats.other')
							}}</span>
						</div>
						<!-- Everything not successful: pending double-opt-in, spam, invalid,
							and duplicates. The backend denormalizes only total + successful,
							so this is the honest derived remainder (not just duplicates). -->
						<p class="text-xl font-semibold text-warning">
							{{ form.totalSubmissions - form.successfulSubmissions }}
						</p>
					</div>
				</div>
			</div>

			<!-- Recent submissions -->
			<FormsSubmissionsPanel :form-endpoint-id="form._id" />

			<!-- Endpoint URL -->
			<div>
				<h4 class="text-sm font-medium text-text-primary mb-2">
					{{ t('dashboard.admin.instance.forms.endpointUrl') }}
				</h4>
				<div class="flex items-center gap-2">
					<code
						class="flex-1 bg-bg-deep px-3 py-2 rounded-lg text-sm text-text-secondary font-mono break-all"
					>
						{{ formUrl }}
					</code>
					<UiTooltip :text="t('dashboard.admin.instance.forms.copyUrl')">
						<UiButton
							variant="ghost"
							class="p-2"
							:aria-label="t('dashboard.admin.instance.forms.copyUrl')"
							@click="emit('copy', formUrl, `url-${form._id}`)"
						>
							<CheckIcon v-if="copiedCode === `url-${form._id}`" class="w-4 h-4 text-success" />
							<CopyIcon v-else class="w-4 h-4" />
						</UiButton>
					</UiTooltip>
				</div>
			</div>

			<!-- Embed Code -->
			<div>
				<div class="flex items-center justify-between mb-2">
					<h4 class="text-sm font-medium text-text-primary">
						{{ t('dashboard.admin.instance.forms.embedCode') }}
					</h4>
					<UiButton
						variant="ghost"
						class="gap-1.5 text-sm py-1.5 px-3"
						@click="emit('copy', embedCode, `embed-${form._id}`)"
					>
						<CheckIcon v-if="copiedCode === `embed-${form._id}`" class="w-4 h-4 text-success" />
						<CopyIcon v-else class="w-4 h-4" />
						{{
							copiedCode === `embed-${form._id}`
								? t('dashboard.admin.instance.forms.copied')
								: t('dashboard.admin.instance.forms.copyCode')
						}}
					</UiButton>
				</div>
				<pre
					class="bg-bg-deep px-4 py-3 rounded-lg text-sm text-text-secondary font-mono overflow-x-auto whitespace-pre-wrap break-all"
					>{{ embedCode }}</pre>
			</div>

			<!-- Help Text -->
			<div class="p-4 bg-bg-surface rounded-xl border border-border-subtle">
				<p class="text-sm text-text-secondary">
					<I18nT keypath="dashboard.admin.instance.forms.tip" tag="span" scope="global">
						<template #label>
							<strong class="text-text-primary">{{
								t('dashboard.admin.instance.forms.tipLabel')
							}}</strong>
						</template>
					</I18nT>
					<a
						href="https://docs.owlat.app/developer/forms"
						target="_blank"
						rel="noopener"
						class="inline-flex items-center gap-1 text-brand hover:underline ml-1"
					>
						{{ t('common.learnMore') }}
						<ExternalLinkIcon class="w-3 h-3" />
					</a>
				</p>
			</div>
		</div>
	</div>
</template>
