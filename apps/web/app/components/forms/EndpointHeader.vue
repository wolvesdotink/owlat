<script setup lang="ts">
// The clickable header of one form endpoint card on the forms admin page:
// name, status, topic, submission count and creation date, then the active
// switch, edit, delete and the expand arrow. The page owns every action.
import {
	ChevronDownIcon,
	CircleCheckIcon,
	CircleCloseIcon,
	FileTextIcon,
	Slider1Icon,
	TrashIcon,
} from '@coolicons/vue';

defineProps<{
	form: { _id?: string; name: string; isActive: boolean; totalSubmissions: number };
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
	<!-- The row is a pointer target for the expander; the name block is the
	     keyboard control, and the actions on the right stay independent. -->
	<div
		class="px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between cursor-pointer hover:bg-bg-surface/50 transition-colors"
		@click="emit('toggle')"
	>
		<button
			type="button"
			class="flex min-w-0 flex-1 items-center gap-4 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base"
			:aria-expanded="expanded"
			:aria-controls="expanded && form._id ? `form-endpoint-details-${form._id}` : undefined"
			@click.stop="emit('toggle')"
		>
			<UiIconBox :icon="FileTextIcon" size="sm" variant="surface" rounded="lg" />
			<span class="block min-w-0">
				<span class="flex flex-wrap items-center gap-x-3 gap-y-1">
					<span class="font-medium text-text-primary break-words">{{ form.name }}</span>
					<span
						:class="[
							'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
							form.isActive ? 'bg-success/10 text-success' : 'bg-bg-surface text-text-tertiary',
						]"
					>
						<component :is="form.isActive ? CircleCheckIcon : CircleCloseIcon" class="w-3 h-3" />
						{{ form.isActive ? t('common.active') : t('common.inactive') }}
					</span>
				</span>
				<span class="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-sm text-text-tertiary">
					<span>{{
						t('dashboard.admin.instance.forms.topicLine', {
							topic: topicName,
						})
					}}</span>
					<span class="text-border-default" aria-hidden="true">&bull;</span>
					<span>{{
						t('dashboard.admin.instance.forms.submissionsCount', {
							count: form.totalSubmissions,
						})
					}}</span>
					<span class="text-border-default" aria-hidden="true">&bull;</span>
					<span>{{
						t('dashboard.admin.instance.forms.createdOn', {
							date: createdOn,
						})
					}}</span>
				</span>
			</span>
		</button>

		<div class="flex shrink-0 items-center justify-end gap-2">
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
					variant="danger-ghost"
					class="p-2"
					:aria-label="t('dashboard.admin.instance.forms.deleteForm')"
					@click.stop="emit('delete')"
				>
					<TrashIcon class="w-4 h-4" />
				</UiButton>
			</UiTooltip>
			<!-- Expand Arrow -->
			<ChevronDownIcon
				:class="['w-4 h-4 text-text-tertiary transition-transform', expanded ? 'rotate-180' : '']"
				aria-hidden="true"
			/>
		</div>
	</div>
</template>
