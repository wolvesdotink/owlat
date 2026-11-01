<script setup lang="ts">
// The clickable header of one form endpoint card on the forms admin page:
// name, status, topic, submission count and creation date, then the active
// switch, edit, delete and the expand arrow. The page owns every action.
import {
	CircleCheckIcon,
	CircleCloseIcon,
	FileTextIcon,
	Slider1Icon,
	TrashIcon,
} from '@coolicons/vue';

defineProps<{
	form: { name: string; isActive: boolean; totalSubmissions: number };
	topicName: string;
	/** The creation date, already formatted. */
	createdOn: string;
	expanded: boolean;
}>();

const emit = defineEmits<{
	toggle: [];
	'toggle-active': [];
	edit: [];
	delete: [];
}>();

const { t } = useI18n();
</script>

<template>
	<div
		class="px-6 py-4 flex items-center justify-between cursor-pointer hover:bg-bg-surface/50 transition-colors"
		@click="emit('toggle')"
	>
		<div class="flex items-center gap-4">
			<UiIconBox :icon="FileTextIcon" size="sm" variant="surface" rounded="lg" />
			<div>
				<div class="flex items-center gap-3">
					<p class="font-medium text-text-primary">{{ form.name }}</p>
					<span
						:class="[
							'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border',
							form.isActive
								? 'bg-success/20 text-success border-success/30'
								: 'bg-text-tertiary/20 text-text-tertiary border-text-tertiary/30',
						]"
					>
						<component :is="form.isActive ? CircleCheckIcon : CircleCloseIcon" class="w-3 h-3" />
						{{ form.isActive ? t('common.active') : t('common.inactive') }}
					</span>
				</div>
				<div class="flex items-center gap-4 mt-1 text-sm text-text-tertiary">
					<span>{{
						t('dashboard.admin.instance.forms.topicLine', {
							topic: topicName,
						})
					}}</span>
					<span class="text-border-default">&bull;</span>
					<span>{{
						t('dashboard.admin.instance.forms.submissionsCount', {
							count: form.totalSubmissions,
						})
					}}</span>
					<span class="text-border-default">&bull;</span>
					<span>{{
						t('dashboard.admin.instance.forms.createdOn', {
							date: createdOn,
						})
					}}</span>
				</div>
			</div>
		</div>

		<div class="flex items-center gap-2">
			<!-- Active: the switch's state is the form's state -->
			<UiSwitch
				:model-value="form.isActive"
				:label="form.name"
				class="mr-1"
				@click.stop
				@update:model-value="emit('toggle-active')"
			/>
			<!-- Edit -->
			<UiTooltip :text="t('dashboard.admin.instance.forms.editForm')">
				<UiButton
					variant="ghost"
					class="p-2"
					:aria-label="t('dashboard.admin.instance.forms.editForm')"
					@click.stop="emit('edit')"
				>
					<Slider1Icon class="w-4 h-4" />
				</UiButton>
			</UiTooltip>
			<!-- Delete -->
			<UiTooltip :text="t('dashboard.admin.instance.forms.deleteForm')">
				<UiButton
					variant="ghost"
					class="p-2 text-error hover:bg-error/10"
					:aria-label="t('dashboard.admin.instance.forms.deleteForm')"
					@click.stop="emit('delete')"
				>
					<TrashIcon class="w-4 h-4" />
				</UiButton>
			</UiTooltip>
			<!-- Expand Arrow -->
			<div
				:class="[
					'w-5 h-5 flex items-center justify-center transition-transform',
					expanded ? 'rotate-180' : '',
				]"
			>
				<svg
					class="w-4 h-4 text-text-tertiary"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M19 9l-7 7-7-7"
					/>
				</svg>
			</div>
		</div>
	</div>
</template>
