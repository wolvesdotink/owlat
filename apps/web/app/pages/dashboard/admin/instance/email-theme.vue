<script setup lang="ts">
import { api } from '@owlat/api';

const { t } = useI18n();

useHead({ title: () => t('dashboard.admin.instance.emailTheme.pageTitle') });

definePageMeta({
	layout: 'dashboard',
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

// Save settings
const handleSave = async () => {
	if (!hasActiveOrganization.value) return;

	if (!validateForm()) return;

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

	if (!result.ok) return;

	showNotification(t('dashboard.admin.instance.emailTheme.savedToast'));
	isFormDirty.value = false;
};

// Reset to defaults
const handleReset = () => {
	form.primaryColor = defaultTheme.primaryColor;
	form.fontFamily = defaultTheme.fontFamily;
	form.backgroundColor = defaultTheme.backgroundColor;
	form.baseWidth = defaultTheme.baseWidth;
};

// Compute text color for preview (black or white based on background)
const previewTextColor = computed(() => {
	const hex = form.backgroundColor.replace('#', '');
	const r = parseInt(hex.substring(0, 2), 16);
	const g = parseInt(hex.substring(2, 4), 16);
	const b = parseInt(hex.substring(4, 6), 16);
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.5 ? '#374151' : '#f3f4f6';
});

// Compute button text color
const buttonTextColor = computed(() => {
	const hex = form.primaryColor.replace('#', '');
	const r = parseInt(hex.substring(0, 2), 16);
	const g = parseInt(hex.substring(2, 4), 16);
	const b = parseInt(hex.substring(4, 6), 16);
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.5 ? '#12110e' : '#ffffff';
});
</script>

<template>
	<div class="p-6 lg:p-8">
		<!-- Header -->
		<div class="mb-6">
			<NuxtLink
				to="/dashboard/admin"
				class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				{{ t('dashboard.admin.instance.emailTheme.backToSettings') }}
			</NuxtLink>
			<h1 class="text-2xl font-medium tracking-[-0.02em] text-text-primary">
				{{ t('dashboard.admin.instance.emailTheme.title') }}
			</h1>
			<p class="mt-1 text-text-secondary">
				{{ t('dashboard.admin.instance.emailTheme.subtitle') }}
			</p>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading && !organizationSettings" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">
					{{ t('dashboard.admin.instance.emailTheme.loading') }}
				</p>
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
								<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin motion-reduce:animate-none" />
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
			<div class="card p-0 overflow-hidden">
				<div class="px-6 py-4 border-b border-border-subtle">
					<h2 class="text-lg font-semibold text-text-primary">{{ t('common.preview') }}</h2>
					<p class="text-sm text-text-secondary">
						{{ t('dashboard.admin.instance.emailTheme.previewSubtitle') }}
					</p>
				</div>

				<div class="p-6">
					<!-- Email Preview Container -->
					<div
						class="rounded-xl overflow-hidden border border-border-subtle mx-auto transition-all duration-(--motion-moderate)"
						:style="{ backgroundColor: form.backgroundColor, maxWidth: form.baseWidth + 'px' }"
					>
						<!-- Email Content Preview -->
						<div class="p-8">
							<!-- Header Text -->
							<h1
								class="text-2xl font-bold mb-4"
								:style="{
									fontFamily: form.fontFamily,
									color: previewTextColor,
								}"
							>
								{{ t('dashboard.admin.instance.emailTheme.preview.heading') }}
							</h1>

							<!-- Body Text -->
							<p
								class="mb-6 leading-relaxed"
								:style="{
									fontFamily: form.fontFamily,
									color: previewTextColor,
								}"
							>
								{{ t('dashboard.admin.instance.emailTheme.preview.body') }}
							</p>

							<!-- Button Preview -->
							<button
								class="px-6 py-3 rounded-lg font-semibold transition-all"
								:style="{
									backgroundColor: form.primaryColor,
									color: buttonTextColor,
									fontFamily: form.fontFamily,
								}"
							>
								{{ t('dashboard.admin.instance.emailTheme.preview.button') }}
							</button>

							<!-- Footer Text -->
							<p
								class="mt-8 text-sm opacity-70"
								:style="{
									fontFamily: form.fontFamily,
									color: previewTextColor,
								}"
							>
								{{ t('dashboard.admin.instance.emailTheme.preview.footer') }}
							</p>
						</div>
					</div>

					<!-- Preview Note -->
					<p class="mt-4 text-xs text-text-tertiary text-center">
						{{ t('dashboard.admin.instance.emailTheme.preview.note') }}
					</p>
				</div>
			</div>
		</div>
	</div>
</template>
