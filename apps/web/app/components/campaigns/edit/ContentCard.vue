<script setup lang="ts">
// The campaign editor's "Email content" card: the linked email (with its Edit
// link) and the subject line. The Edit link's click goes back to the page,
// which decides whether unsaved form edits need a prompt first.
import { EyeIcon, MailIcon } from '@coolicons/vue';

defineProps<{
	template: { _id: string; name: string; subject?: string } | null;
	contentError?: string;
	subjectError?: string;
	disabled: boolean;
}>();

const subject = defineModel<string>('subject', { required: true });

const emit = defineEmits<{ editEmailClick: [event: MouseEvent, url: string] }>();

const { t } = useI18n();
</script>

<template>
	<div class="card p-6">
		<h2 class="text-lg font-semibold text-text-primary mb-6">
			{{ t('dashboard.campaigns.detail.edit.content.title') }}
		</h2>

		<div class="space-y-6">
			<!-- Selected Template -->
			<div>
				<label class="label">
					{{ t('dashboard.campaigns.detail.edit.content.template') }}
					<span class="text-error">*</span>
				</label>
				<div v-if="template" class="mt-2 p-4 bg-bg-surface shadow-surface-1 rounded-lg">
					<div class="flex flex-wrap items-center justify-between gap-3">
						<div class="flex min-w-0 flex-1 basis-56 items-center gap-3">
							<div
								class="w-10 h-10 shrink-0 rounded-lg bg-brand/20 flex items-center justify-center text-brand"
							>
								<MailIcon class="w-5 h-5" />
							</div>
							<div class="min-w-0">
								<p class="font-medium text-text-primary truncate">
									{{ template.name }}
								</p>
								<p class="text-sm text-text-secondary truncate">
									{{ template.subject || t('dashboard.campaigns.detail.edit.content.noSubject') }}
								</p>
							</div>
						</div>
						<NuxtLink
							:to="`/dashboard/send/emails/${template._id}/edit`"
							class="text-brand hover:text-brand-hover flex shrink-0 items-center gap-1 text-sm whitespace-nowrap"
							target="_blank"
							@click="emit('editEmailClick', $event, `/dashboard/send/emails/${template._id}/edit`)"
						>
							<EyeIcon class="w-4 h-4" />
							{{ t('dashboard.campaigns.detail.edit.content.editEmail') }}
						</NuxtLink>
					</div>
				</div>
				<div v-else class="mt-2 p-4 bg-bg-surface shadow-surface-1 rounded-lg text-text-tertiary">
					{{ t('dashboard.campaigns.detail.edit.content.noTemplate') }}
				</div>
				<p v-if="contentError" class="mt-1.5 text-sm text-error">
					{{ contentError }}
				</p>

				<p class="mt-3 text-sm text-text-tertiary">
					{{ t('dashboard.campaigns.detail.edit.content.linkedEmailNote') }}
				</p>
			</div>

			<!-- Subject Line -->
			<div>
				<label for="subject" class="label flex items-center gap-2">
					<MailIcon class="w-4 h-4 text-text-tertiary" />
					{{ t('dashboard.campaigns.detail.edit.content.subject') }}
					<span class="text-error">*</span>
				</label>
				<input
					id="subject"
					v-model="subject"
					type="text"
					:placeholder="t('dashboard.campaigns.detail.edit.content.subjectPlaceholder')"
					:class="['input mt-1.5', subjectError ? 'input-error' : '']"
					:disabled="disabled"
				/>
				<p v-if="subjectError" class="mt-1.5 text-sm text-error">
					{{ subjectError }}
				</p>
			</div>
		</div>
	</div>
</template>
