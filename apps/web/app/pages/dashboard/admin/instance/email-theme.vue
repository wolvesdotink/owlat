<script setup lang="ts">
import { api } from '@owlat/api';
import { UnsavedChangesDialog } from '@owlat/email-builder';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.emailTheme.pageTitle') });

definePageMeta({
	layout: 'admin',
	middleware: ['auth', 'admin'],
});

// Get the current user's organization
const { hasActiveOrganization, isLoading: organizationLoading } = useOrganizationContext();

// Get organization settings with real-time updates
const { data: organizationSettings, isLoading: organizationSettingsLoading } = useOrganizationQuery(
	api.workspaces.settings.get
);

const isLoading = computed(() => organizationLoading.value || organizationSettingsLoading.value);

// Mutations
const { run: updateOrganizationSettings } = useBackendOperation(api.workspaces.settings.update, {
	label: () => t('dashboard.admin.instance.emailTheme.saveOperation'),
});

// Default theme values
const defaultTheme = {
	primaryColor: '#c4785a',
	fontFamily: 'Arial, sans-serif',
	backgroundColor: '#ffffff',
	baseWidth: 600,
};

// Font options — a computed rather than a frozen array so the labels follow the
// active locale instead of the one that happened to be active at setup.
const fontOptions = computed(() => [
	{ value: 'Arial, sans-serif', label: t('dashboard.admin.instance.emailTheme.fonts.arial') },
	{
		value: "'Helvetica Neue', Helvetica, sans-serif",
		label: t('dashboard.admin.instance.emailTheme.fonts.helvetica'),
	},
	{ value: 'Georgia, serif', label: t('dashboard.admin.instance.emailTheme.fonts.georgia') },
	{
		value: "'Times New Roman', serif",
		label: t('dashboard.admin.instance.emailTheme.fonts.timesNewRoman'),
	},
	{ value: 'Verdana, sans-serif', label: t('dashboard.admin.instance.emailTheme.fonts.verdana') },
	{
		value: "'Trebuchet MS', sans-serif",
		label: t('dashboard.admin.instance.emailTheme.fonts.trebuchetMs'),
	},
	{
		value: "'Courier New', monospace",
		label: t('dashboard.admin.instance.emailTheme.fonts.courierNew'),
	},
	{
		value: 'system-ui, sans-serif',
		label: t('dashboard.admin.instance.emailTheme.fonts.systemDefault'),
	},
]);

// Form state
const form = reactive({
	primaryColor: defaultTheme.primaryColor,
	fontFamily: defaultTheme.fontFamily,
	backgroundColor: defaultTheme.backgroundColor,
	baseWidth: defaultTheme.baseWidth,
});

// Track if form has been modified
const isFormDirty = ref(false);
const isSaving = ref(false);

// Initialize form when organization settings load
watch(
	organizationSettings,
	(settings) => {
		if (settings) {
			const theme = settings.emailTheme;
			form.primaryColor = theme?.primaryColor || defaultTheme.primaryColor;
			form.fontFamily = theme?.fontFamily || defaultTheme.fontFamily;
			form.backgroundColor = theme?.backgroundColor || defaultTheme.backgroundColor;
			form.baseWidth = theme?.baseWidth || defaultTheme.baseWidth;
			isFormDirty.value = false;
		}
	},
	{ immediate: true }
);

// Watch form changes
watch(
	form,
	() => {
		if (organizationSettings.value) {
			const theme = organizationSettings.value.emailTheme;
			const hasChanges =
				form.primaryColor !== (theme?.primaryColor || defaultTheme.primaryColor) ||
				form.fontFamily !== (theme?.fontFamily || defaultTheme.fontFamily) ||
				form.backgroundColor !== (theme?.backgroundColor || defaultTheme.backgroundColor) ||
				form.baseWidth !== (theme?.baseWidth || defaultTheme.baseWidth);
			isFormDirty.value = hasChanges;
		}
	},
	{ deep: true }
);

// Toast notifications (global)
const { showToast: showNotification } = useToast();

// Validate hex color
const isValidHexColor = (color: string): boolean => {
	return /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(color);
};

// Form errors
const formErrors = reactive({
	primaryColor: '',
	backgroundColor: '',
});

// Validate form
const validateForm = (): boolean => {
	formErrors.primaryColor = '';
	formErrors.backgroundColor = '';

	let isValid = true;

	if (!isValidHexColor(form.primaryColor)) {
		formErrors.primaryColor = t('dashboard.admin.instance.emailTheme.errors.primaryColor');
		isValid = false;
	}

	if (!isValidHexColor(form.backgroundColor)) {
		formErrors.backgroundColor = t('dashboard.admin.instance.emailTheme.errors.backgroundColor');
		isValid = false;
	}

	return isValid;
};

// Save settings. Resolves to whether the save succeeded so the unsaved-changes
// guard can keep the operator on the page (and keep their edits) when it fails.
const handleSave = async (): Promise<boolean> => {
	if (!hasActiveOrganization.value) return false;

	if (!validateForm()) return false;

	isSaving.value = true;

	const result = await updateOrganizationSettings({
		emailTheme: {
			primaryColor: form.primaryColor,
			fontFamily: form.fontFamily,
			backgroundColor: form.backgroundColor,
			baseWidth: form.baseWidth,
		},
	});
	isSaving.value = false;

	if (!result.ok) return false;

	showNotification(t('dashboard.admin.instance.emailTheme.savedToast'));
	isFormDirty.value = false;
	return true;
};

// Unsaved-changes guard: navigating away with an unsaved theme edit prompts to
// save/discard instead of silently dropping it. Same shared composable + dialog
// the General settings page uses; `onSave` throws on failure so a failed save
// keeps the operator here.
const {
	showDialog: showUnsavedDialog,
	confirmDiscard,
	confirmSave,
	cancelNavigation,
	setHasChanges,
} = useUnsavedChanges({
	onSave: async () => {
		if (!(await handleSave())) throw new Error('Save failed');
	},
});

watch(isFormDirty, (dirty) => setHasChanges(dirty), { immediate: true });

// Reset to defaults
const handleReset = () => {
	form.primaryColor = defaultTheme.primaryColor;
	form.fontFamily = defaultTheme.fontFamily;
	form.backgroundColor = defaultTheme.backgroundColor;
	form.baseWidth = defaultTheme.baseWidth;
};

// The live preview (and the two contrast computations it needs) lives in
// `components/email/ThemePreview.vue` — it only reads the theme.
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.instance.emailTheme.title') }}
			</h1>
			<p class="mt-1 text-text-secondary">
				{{ t('dashboard.admin.instance.emailTheme.subtitle') }}
			</p>
		</div>

		<!--
			First load: a content-shaped placeholder at the geometry of the form
			card and its live preview, rather than a centred spinner that blanks
			the page and then reflows.
		-->
		<div
			v-if="isLoading && !organizationSettings"
			class="grid gap-8 lg:grid-cols-2"
			role="status"
			aria-busy="true"
			:aria-label="t('dashboard.admin.instance.emailTheme.loading')"
		>
			<div class="card space-y-4">
				<UiSkeleton class="h-5 w-48" />
				<UiSkeletonText :lines="2" size="sm" last-line-width="w-1/2" />
				<UiSkeleton v-for="field in 4" :key="field" class="h-10 rounded-lg" />
			</div>
			<div class="card space-y-4">
				<UiSkeleton class="h-5 w-32" />
				<UiSkeleton class="h-64 rounded-lg" />
			</div>
		</div>

		<!-- Settings Content -->
		<div v-else class="grid gap-8 lg:grid-cols-2">
			<!-- Settings Form -->
			<div class="card p-0 overflow-hidden">
				<div class="px-6 py-4 border-b border-border-subtle">
					<div class="flex items-center gap-3">
						<UiIconBox icon="lucide:palette" size="sm" variant="surface" rounded="lg" />
						<div>
							<h2 class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.admin.instance.emailTheme.settingsTitle') }}
							</h2>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.admin.instance.emailTheme.settingsSubtitle') }}
							</p>
						</div>
					</div>
				</div>

				<form class="p-6" @submit.prevent="handleSave">
					<div class="grid gap-6">
						<!-- Primary Color -->
						<div>
							<label for="primary-color" class="label flex items-center gap-2">
								<Icon name="lucide:palette" class="w-4 h-4 text-text-tertiary" />
								{{ t('dashboard.admin.instance.emailTheme.primaryColor') }}
							</label>
							<div class="flex items-center gap-3">
								<input
									id="primary-color-picker"
									v-model="form.primaryColor"
									type="color"
									class="w-12 h-10 rounded-lg shadow-surface-1 cursor-pointer bg-transparent"
									:disabled="isSaving"
								/>
								<input
									id="primary-color"
									v-model="form.primaryColor"
									type="text"
									placeholder="#c4785a"
									:class="['input flex-1', formErrors.primaryColor && 'input-error']"
									:disabled="isSaving"
								/>
							</div>
							<p v-if="formErrors.primaryColor" class="mt-1 text-xs text-error">
								{{ formErrors.primaryColor }}
							</p>
							<p v-else class="mt-1 text-xs text-text-tertiary">
								{{ t('dashboard.admin.instance.emailTheme.primaryColorHelp') }}
							</p>
						</div>

						<!-- Background Color -->
						<div>
							<label for="background-color" class="label flex items-center gap-2">
								<Icon name="lucide:palette" class="w-4 h-4 text-text-tertiary" />
								{{ t('dashboard.admin.instance.emailTheme.backgroundColor') }}
							</label>
							<div class="flex items-center gap-3">
								<input
									id="background-color-picker"
									v-model="form.backgroundColor"
									type="color"
									class="w-12 h-10 rounded-lg shadow-surface-1 cursor-pointer bg-transparent"
									:disabled="isSaving"
								/>
								<input
									id="background-color"
									v-model="form.backgroundColor"
									type="text"
									placeholder="#ffffff"
									:class="['input flex-1', formErrors.backgroundColor && 'input-error']"
									:disabled="isSaving"
								/>
							</div>
							<p v-if="formErrors.backgroundColor" class="mt-1 text-xs text-error">
								{{ formErrors.backgroundColor }}
							</p>
							<p v-else class="mt-1 text-xs text-text-tertiary">
								{{ t('dashboard.admin.instance.emailTheme.backgroundColorHelp') }}
							</p>
						</div>

						<!-- Font Family -->
						<div>
							<label for="font-family" class="label flex items-center gap-2">
								<Icon name="lucide:type" class="w-4 h-4 text-text-tertiary" />
								{{ t('dashboard.admin.instance.emailTheme.fontFamily') }}
							</label>
							<select id="font-family" v-model="form.fontFamily" class="input" :disabled="isSaving">
								<option v-for="font in fontOptions" :key="font.value" :value="font.value">
									{{ font.label }}
								</option>
							</select>
							<p class="mt-1 text-xs text-text-tertiary">
								{{ t('dashboard.admin.instance.emailTheme.fontFamilyHelp') }}
							</p>
						</div>

						<!-- Email Width -->
						<div>
							<label for="base-width" class="label flex items-center gap-2">
								<Icon name="lucide:move-horizontal" class="w-4 h-4 text-text-tertiary" />
								{{ t('dashboard.admin.instance.emailTheme.emailWidth') }}
							</label>
							<div class="flex items-center gap-3">
								<input
									id="base-width"
									v-model.number="form.baseWidth"
									type="range"
									min="400"
									max="800"
									step="10"
									class="flex-1 accent-brand"
									:disabled="isSaving"
								/>
								<div class="flex items-center gap-1">
									<input
										v-model.number="form.baseWidth"
										type="number"
										min="400"
										max="800"
										step="10"
										class="input w-20 text-center"
										:disabled="isSaving"
									/>
									<span class="text-sm text-text-tertiary">
										{{ t('dashboard.admin.instance.emailTheme.px') }}
									</span>
								</div>
							</div>
							<p class="mt-1 text-xs text-text-tertiary">
								{{ t('dashboard.admin.instance.emailTheme.emailWidthHelp') }}
							</p>
						</div>
					</div>

					<!-- Action Buttons -->
					<div class="flex items-center justify-between pt-6 mt-6 border-t border-border-subtle">
						<UiButton
							variant="ghost"
							type="button"
							class="gap-2"
							:disabled="isSaving"
							@click="handleReset"
						>
							<Icon name="lucide:refresh-cw" class="w-4 h-4" />
							{{ t('dashboard.admin.instance.emailTheme.resetToDefaults') }}
						</UiButton>

						<div class="flex items-center gap-3">
							<p v-if="isFormDirty" class="text-sm text-warning flex items-center gap-2">
								<Icon name="lucide:alert-circle" class="w-4 h-4" />
								{{ t('dashboard.admin.instance.emailTheme.unsaved') }}
							</p>

							<UiButton type="submit" class="gap-2" :disabled="isSaving || !isFormDirty">
								<Icon
									v-if="isSaving"
									name="lucide:loader-2"
									class="w-4 h-4 animate-spin motion-reduce:animate-none"
								/>
								<Icon v-else name="lucide:check" class="w-4 h-4" />
								{{
									isSaving
										? t('dashboard.admin.instance.emailTheme.savingTheme')
										: t('dashboard.admin.instance.emailTheme.saveTheme')
								}}
							</UiButton>
						</div>
					</div>
				</form>
			</div>

			<!-- Theme Preview -->
			<EmailThemePreview
				:primary-color="form.primaryColor"
				:font-family="form.fontFamily"
				:background-color="form.backgroundColor"
				:base-width="form.baseWidth"
			/>
		</div>

		<!-- Unsaved Changes Dialog -->
		<UnsavedChangesDialog
			:show="showUnsavedDialog"
			@close="cancelNavigation"
			@discard="confirmDiscard"
			@save="confirmSave"
		/>
	</div>
</template>
