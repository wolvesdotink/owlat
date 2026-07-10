<script setup lang="ts">
import { api } from '@owlat/api';

useHead({ title: 'Email Theme — Owlat' });

definePageMeta({
	layout: 'dashboard',
	middleware: 'auth',
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
	label: 'Save email theme',
});

// Default theme values
const defaultTheme = {
	primaryColor: '#c4785a',
	fontFamily: 'Arial, sans-serif',
	backgroundColor: '#ffffff',
	baseWidth: 600,
};

// Font options
const fontOptions = [
	{ value: 'Arial, sans-serif', label: 'Arial' },
	{ value: "'Helvetica Neue', Helvetica, sans-serif", label: 'Helvetica' },
	{ value: 'Georgia, serif', label: 'Georgia' },
	{ value: "'Times New Roman', serif", label: 'Times New Roman' },
	{ value: 'Verdana, sans-serif', label: 'Verdana' },
	{ value: "'Trebuchet MS', sans-serif", label: 'Trebuchet MS' },
	{ value: "'Courier New', monospace", label: 'Courier New' },
	{ value: 'system-ui, sans-serif', label: 'System Default' },
];

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
		formErrors.primaryColor = 'Please enter a valid hex color (e.g., #c4785a)';
		isValid = false;
	}

	if (!isValidHexColor(form.backgroundColor)) {
		formErrors.backgroundColor = 'Please enter a valid hex color (e.g., #ffffff)';
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

	if (result === undefined) return;

	showNotification('Email theme saved successfully');
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
				to="/dashboard/settings"
				class="inline-flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors mb-4"
			>
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
				Back to Settings
			</NuxtLink>
			<h1 class="text-2xl font-semibold text-text-primary">Email Theme</h1>
			<p class="mt-1 text-text-secondary">Configure default styling for your email templates</p>
		</div>

		<!-- Loading State -->
		<div v-if="isLoading && !organizationSettings" class="flex items-center justify-center py-16">
			<div class="flex flex-col items-center gap-3">
				<UiSpinner />
				<p class="text-text-secondary text-sm">Loading theme settings...</p>
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
							<h2 class="text-lg font-semibold text-text-primary">Theme Settings</h2>
							<p class="text-sm text-text-secondary">Set colors and fonts for your emails</p>
						</div>
					</div>
				</div>

				<form class="p-6" @submit.prevent="handleSave">
					<div class="grid gap-6">
						<!-- Primary Color -->
						<div>
							<label for="primary-color" class="label flex items-center gap-2">
								<Icon name="lucide:palette" class="w-4 h-4 text-text-tertiary" />
								Primary Color
							</label>
							<div class="flex items-center gap-3">
								<input
									id="primary-color-picker"
									v-model="form.primaryColor"
									type="color"
									class="w-12 h-10 rounded-lg border border-border-subtle cursor-pointer bg-transparent"
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
								Used for buttons and call-to-action elements in your emails.
							</p>
						</div>

						<!-- Background Color -->
						<div>
							<label for="background-color" class="label flex items-center gap-2">
								<Icon name="lucide:palette" class="w-4 h-4 text-text-tertiary" />
								Background Color
							</label>
							<div class="flex items-center gap-3">
								<input
									id="background-color-picker"
									v-model="form.backgroundColor"
									type="color"
									class="w-12 h-10 rounded-lg border border-border-subtle cursor-pointer bg-transparent"
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
								The background color of your email body.
							</p>
						</div>

						<!-- Font Family -->
						<div>
							<label for="font-family" class="label flex items-center gap-2">
								<Icon name="lucide:type" class="w-4 h-4 text-text-tertiary" />
								Font Family
							</label>
							<select id="font-family" v-model="form.fontFamily" class="input" :disabled="isSaving">
								<option v-for="font in fontOptions" :key="font.value" :value="font.value">
									{{ font.label }}
								</option>
							</select>
							<p class="mt-1 text-xs text-text-tertiary">
								The default font for text content in your emails.
							</p>
						</div>

						<!-- Email Width -->
						<div>
							<label for="base-width" class="label flex items-center gap-2">
								<Icon name="lucide:move-horizontal" class="w-4 h-4 text-text-tertiary" />
								Email Width
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
									<span class="text-sm text-text-tertiary">px</span>
								</div>
							</div>
							<p class="mt-1 text-xs text-text-tertiary">
								Maximum width of your email on desktop (400–800px). Default is 600px.
							</p>
						</div>
					</div>

					<!-- Action Buttons -->
					<div class="flex items-center justify-between pt-6 mt-6 border-t border-border-subtle">
						<button
							type="button"
							class="btn btn-ghost gap-2"
							:disabled="isSaving"
							@click="handleReset"
						>
							<Icon name="lucide:refresh-cw" class="w-4 h-4" />
							Reset to Defaults
						</button>

						<div class="flex items-center gap-3">
							<p v-if="isFormDirty" class="text-sm text-warning flex items-center gap-2">
								<Icon name="lucide:alert-circle" class="w-4 h-4" />
								Unsaved
							</p>

							<button
								type="submit"
								class="btn btn-primary gap-2"
								:disabled="isSaving || !isFormDirty"
							>
								<Icon v-if="isSaving" name="lucide:loader-2" class="w-4 h-4 animate-spin" />
								<Icon v-else name="lucide:check" class="w-4 h-4" />
								{{ isSaving ? 'Saving...' : 'Save Theme' }}
							</button>
						</div>
					</div>
				</form>
			</div>

			<!-- Theme Preview -->
			<div class="card p-0 overflow-hidden">
				<div class="px-6 py-4 border-b border-border-subtle">
					<h2 class="text-lg font-semibold text-text-primary">Preview</h2>
					<p class="text-sm text-text-secondary">See how your theme looks in emails</p>
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
								Welcome to Our Newsletter
							</h1>

							<!-- Body Text -->
							<p
								class="mb-6 leading-relaxed"
								:style="{
									fontFamily: form.fontFamily,
									color: previewTextColor,
								}"
							>
								Thank you for subscribing! We're excited to have you on board. Stay tuned for
								updates, tips, and exclusive content delivered straight to your inbox.
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
								Get Started
							</button>

							<!-- Footer Text -->
							<p
								class="mt-8 text-sm opacity-70"
								:style="{
									fontFamily: form.fontFamily,
									color: previewTextColor,
								}"
							>
								You're receiving this email because you signed up for our newsletter.
							</p>
						</div>
					</div>

					<!-- Preview Note -->
					<p class="mt-4 text-xs text-text-tertiary text-center">
						This is a simplified preview. Actual emails may vary based on email client rendering.
					</p>
				</div>
			</div>
		</div>
	</div>
</template>
