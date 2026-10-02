<script setup lang="ts">
/**
 * Brand kit: the organization's logo, colours, fonts, button style and
 * footer, which every new email starts from and the editor offers everywhere.
 * Replaces the email theme page (which held the primary colour, font,
 * background and width, still saved in the same place).
 */
import { api } from '@owlat/api';
import type { Id } from '@owlat/api/dataModel';
import { UnsavedChangesDialog } from '@owlat/email-builder';
import {
	BRAND_BASE_WIDTH_RANGE,
	BRAND_BUTTON_PADDING_X_RANGE,
	BRAND_BUTTON_PADDING_Y_RANGE,
	BRAND_BUTTON_RADIUS_RANGE,
	DEFAULT_BRAND_KIT_DESIGN,
	MAX_BRAND_ADDRESS_LENGTH,
	MAX_BRAND_COMPANY_NAME_LENGTH,
	brandKitDesignProblem,
	type BrandKitDesign,
} from '@owlat/shared/brandKit';
import type { BrandLogoAsset } from '@owlat/shared/brandKitBlocks';
import type { BrandKitImportSelection } from '~/components/brand-kit/ImportDialog.vue';
import { useSettingsForm } from '~/composables/useSettingsForm';

const { t } = useI18n();
useHead({ title: () => t('dashboard.admin.instance.brandKit.pageTitle') });
definePageMeta({ layout: 'admin', middleware: ['auth', 'admin'] });

const { organization } = useOrganizationContext();
const { showToast } = useToast();
const {
	data: brandKit,
	error: brandKitError,
	refetch: refetchBrandKit,
} = useOrganizationQuery(api.workspaces.brandKit.get);

type BrandKitFields = Omit<BrandKitDesign, 'isConfigured'>;
type BrandKitForm = BrandKitFields & {
	logo: BrandLogoAsset | null;
	logoDark: BrandLogoAsset | null;
};

/** The saved design fields of a design or of the form, without the rest. */
function designFields(source: BrandKitFields): BrandKitFields {
	return {
		primaryColor: source.primaryColor,
		secondaryColor: source.secondaryColor,
		textColor: source.textColor,
		backgroundColor: source.backgroundColor,
		linkColor: source.linkColor,
		swatches: [...source.swatches],
		headingFontFamily: source.headingFontFamily,
		bodyFontFamily: source.bodyFontFamily,
		buttonRadius: source.buttonRadius,
		buttonPaddingX: source.buttonPaddingX,
		buttonPaddingY: source.buttonPaddingY,
		baseWidth: source.baseWidth,
		footerCompanyName: source.footerCompanyName,
		footerAddress: source.footerAddress,
		footerSocialLinks: source.footerSocialLinks.map((link) => ({ ...link })),
	};
}

const defaults: BrandKitForm = {
	...designFields(DEFAULT_BRAND_KIT_DESIGN),
	logo: null,
	logoDark: null,
};

const { run: updateBrandKit } = useBackendOperation(api.workspaces.brandKit.update, {
	label: () => t('dashboard.admin.instance.brandKit.saveOperation'),
});

const problem = ref<string | null>(null);

function validate(draft: BrandKitForm): boolean {
	const found = brandKitDesignProblem(designFields(draft));
	problem.value = found ? t(`dashboard.admin.instance.brandKit.errors.${found}`) : null;
	return found === null;
}

async function save(draft: BrandKitForm): Promise<boolean> {
	const { logo, logoDark } = draft;
	const result = await updateBrandKit({
		...designFields(draft),
		...(logo ? { logoMediaAssetId: logo.mediaAssetId as Id<'mediaAssets'> } : {}),
		...(logo && logoDark
			? { logoDarkMediaAssetId: logoDark.mediaAssetId as Id<'mediaAssets'> }
			: {}),
	});
	if (!result.ok) return false;
	showToast(t('dashboard.admin.instance.brandKit.savedToast'));
	return true;
}

const { form, loaded, isDirty, isSaving, handleSave, resetToDefaults, unsavedDialog } =
	useSettingsForm({
		source: brandKit,
		defaults,
		project: (kit) => ({
			...designFields(kit.design),
			logo: kit.logos.light,
			logoDark: kit.logos.dark,
		}),
		validate,
		save,
	});

const previewLogos = computed(() => ({ light: form.logo, dark: form.logo ? form.logoDark : null }));
const workspaceName = computed(() => organization.value?.name?.trim() ?? '');
const isImportOpen = ref(false);

function applyImport(selection: BrandKitImportSelection) {
	Object.assign(form, selection.colors);
	if (selection.companyName) form.footerCompanyName = selection.companyName;
	if (selection.logo) form.logo = selection.logo;
	showToast(t('dashboard.admin.instance.brandKit.import.appliedToast'));
}

const colorFields = [
	['primaryColor', 'primary'],
	['secondaryColor', 'secondary'],
	['textColor', 'text'],
	['backgroundColor', 'background'],
	['linkColor', 'link'],
] as const;
const buttonFields = [
	['buttonRadius', 'radius', BRAND_BUTTON_RADIUS_RANGE],
	['buttonPaddingX', 'paddingX', BRAND_BUTTON_PADDING_X_RANGE],
	['buttonPaddingY', 'paddingY', BRAND_BUTTON_PADDING_Y_RANGE],
] as const;
</script>

<template>
	<div>
		<UiPageHeader
			:title="t('dashboard.admin.instance.brandKit.title')"
			:description="t('dashboard.admin.instance.brandKit.subtitle')"
			class="mb-6"
		>
			<template #actions>
				<UiButton
					variant="secondary"
					:disabled="!loaded || isSaving"
					data-testid="brand-kit-import"
					@click="isImportOpen = true"
				>
					<template #iconLeft><Icon name="lucide:globe" class="w-4 h-4" /></template>
					{{ t('dashboard.admin.instance.brandKit.importButton') }}
				</UiButton>
			</template>
		</UiPageHeader>

		<!-- A failed read shows the error, never the form: a save built on the
		     defaults would write them over the stored kit. -->
		<UiQueryBoundary :loading="!loaded" :error="brandKitError" @retry="refetchBrandKit">
			<template #loading>
				<div
					class="grid gap-8 xl:grid-cols-[minmax(0,32rem)_minmax(0,1fr)]"
					role="status"
					aria-busy="true"
					:aria-label="t('dashboard.admin.instance.brandKit.loading')"
				>
					<div class="space-y-6">
						<div v-for="card in 3" :key="card" class="card space-y-4">
							<UiSkeleton class="h-5 w-40" />
							<UiSkeleton v-for="field in 3" :key="field" class="h-10 rounded-lg" />
						</div>
					</div>
					<div class="card space-y-4">
						<UiSkeleton class="h-5 w-32" />
						<UiSkeleton class="h-96 rounded-lg" />
					</div>
				</div>
			</template>

			<div class="grid gap-8 xl:grid-cols-[minmax(0,32rem)_minmax(0,1fr)] items-start">
				<form class="space-y-6" @submit.prevent="handleSave">
					<!-- Logo -->
					<section class="card space-y-5" aria-labelledby="brand-kit-logo">
						<header>
							<h2 id="brand-kit-logo" class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.admin.instance.brandKit.logo.title') }}
							</h2>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.admin.instance.brandKit.logo.subtitle') }}
							</p>
						</header>
						<BrandKitLogoPicker
							v-model="form.logo"
							:label="t('dashboard.admin.instance.brandKit.logo.light')"
							:help="t('dashboard.admin.instance.brandKit.logo.lightHelp')"
							:disabled="isSaving"
						/>
						<BrandKitLogoPicker
							v-if="form.logo"
							v-model="form.logoDark"
							is-dark
							:label="t('dashboard.admin.instance.brandKit.logo.dark')"
							:help="t('dashboard.admin.instance.brandKit.logo.darkHelp')"
							:disabled="isSaving"
						/>
					</section>

					<!-- Colours -->
					<section class="card space-y-5" aria-labelledby="brand-kit-colors">
						<header>
							<h2 id="brand-kit-colors" class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.admin.instance.brandKit.colors.title') }}
							</h2>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.admin.instance.brandKit.colors.subtitle') }}
							</p>
						</header>
						<div class="grid gap-5 sm:grid-cols-2">
							<BrandKitColorField
								v-for="[key, name] in colorFields"
								:id="`brand-kit-${name}`"
								:key="key"
								v-model="form[key]"
								:label="t(`dashboard.admin.instance.brandKit.colors.${name}`)"
								:help="t(`dashboard.admin.instance.brandKit.colors.${name}Help`)"
								:disabled="isSaving"
							/>
						</div>
						<BrandKitSwatches v-model="form.swatches" :disabled="isSaving" />
					</section>

					<!-- Typography, buttons, width -->
					<section class="card space-y-5" aria-labelledby="brand-kit-typography">
						<header>
							<h2 id="brand-kit-typography" class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.admin.instance.brandKit.typography.title') }}
							</h2>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.admin.instance.brandKit.typography.subtitle') }}
							</p>
						</header>
						<div class="grid gap-5 sm:grid-cols-2">
							<BrandKitFontSelect
								id="brand-kit-heading-font"
								v-model="form.headingFontFamily"
								:label="t('dashboard.admin.instance.brandKit.typography.headingFont')"
								:disabled="isSaving"
							/>
							<BrandKitFontSelect
								id="brand-kit-body-font"
								v-model="form.bodyFontFamily"
								:label="t('dashboard.admin.instance.brandKit.typography.bodyFont')"
								:disabled="isSaving"
							/>
						</div>
						<div>
							<p class="label">{{ t('dashboard.admin.instance.brandKit.buttons.title') }}</p>
							<div class="grid gap-4 sm:grid-cols-3">
								<label v-for="[key, name, range] in buttonFields" :key="key" class="block">
									<span class="text-xs text-text-secondary">
										{{ t(`dashboard.admin.instance.brandKit.buttons.${name}`) }}
									</span>
									<span class="mt-1 flex items-center gap-1">
										<input
											v-model.number="form[key]"
											type="number"
											:min="range.min"
											:max="range.max"
											class="input"
											:disabled="isSaving"
										/>
										<span class="text-sm text-text-tertiary">
											{{ t('dashboard.admin.instance.brandKit.px') }}
										</span>
									</span>
								</label>
							</div>
						</div>
						<div>
							<label for="brand-kit-width" class="label">
								{{ t('dashboard.admin.instance.brandKit.layout.emailWidth') }}
							</label>
							<div class="flex items-center gap-3">
								<input
									id="brand-kit-width"
									v-model.number="form.baseWidth"
									type="range"
									:min="BRAND_BASE_WIDTH_RANGE.min"
									:max="BRAND_BASE_WIDTH_RANGE.max"
									step="10"
									class="flex-1 accent-brand"
									:disabled="isSaving"
								/>
								<span class="w-16 text-right text-sm tabular-nums text-text-secondary">
									{{ form.baseWidth }} {{ t('dashboard.admin.instance.brandKit.px') }}
								</span>
							</div>
							<p class="mt-1 text-xs text-text-tertiary">
								{{ t('dashboard.admin.instance.brandKit.layout.emailWidthHelp') }}
							</p>
						</div>
					</section>

					<!-- Footer -->
					<section class="card space-y-5" aria-labelledby="brand-kit-footer">
						<header>
							<h2 id="brand-kit-footer" class="text-lg font-semibold text-text-primary">
								{{ t('dashboard.admin.instance.brandKit.footer.title') }}
							</h2>
							<p class="text-sm text-text-secondary">
								{{ t('dashboard.admin.instance.brandKit.footer.subtitle') }}
							</p>
						</header>
						<div>
							<UiInput
								id="brand-kit-company"
								v-model="form.footerCompanyName"
								:label="t('dashboard.admin.instance.brandKit.footer.companyName')"
								:maxlength="MAX_BRAND_COMPANY_NAME_LENGTH"
								:disabled="isSaving"
							/>
							<button
								v-if="!form.footerCompanyName && workspaceName"
								type="button"
								class="mt-1 text-xs text-brand hover:underline"
								@click="form.footerCompanyName = workspaceName"
							>
								{{
									t('dashboard.admin.instance.brandKit.footer.useWorkspaceName', {
										name: workspaceName,
									})
								}}
							</button>
						</div>
						<div>
							<UiTextarea
								id="brand-kit-address"
								v-model="form.footerAddress"
								:label="t('dashboard.admin.instance.brandKit.footer.address')"
								:rows="3"
								:max-length="MAX_BRAND_ADDRESS_LENGTH"
								:disabled="isSaving"
							/>
							<p class="mt-1 text-xs text-text-tertiary">
								{{ t('dashboard.admin.instance.brandKit.footer.addressHelp') }}
							</p>
						</div>
						<BrandKitSocialLinks v-model="form.footerSocialLinks" :disabled="isSaving" />
					</section>

					<!-- Actions -->
					<div class="card flex flex-wrap items-center justify-between gap-3">
						<UiButton variant="ghost" type="button" :disabled="isSaving" @click="resetToDefaults">
							<template #iconLeft><Icon name="lucide:refresh-cw" class="w-4 h-4" /></template>
							{{ t('dashboard.admin.instance.brandKit.resetToDefaults') }}
						</UiButton>
						<div class="flex items-center gap-3">
							<p v-if="problem" class="text-sm text-error" role="alert">{{ problem }}</p>
							<p v-else-if="isDirty" class="text-sm text-warning flex items-center gap-2">
								<Icon name="lucide:alert-circle" class="w-4 h-4" />
								{{ t('dashboard.admin.instance.brandKit.unsaved') }}
							</p>
							<UiButton type="submit" :disabled="isSaving || !isDirty || !loaded">
								<template #iconLeft>
									<Icon
										v-if="isSaving"
										name="lucide:loader-2"
										class="w-4 h-4 animate-spin motion-reduce:animate-none"
									/>
									<Icon v-else name="lucide:check" class="w-4 h-4" />
								</template>
								{{
									isSaving
										? t('dashboard.admin.instance.brandKit.saving')
										: t('dashboard.admin.instance.brandKit.save')
								}}
							</UiButton>
						</div>
					</div>
				</form>

				<BrandKitPreview :design="designFields(form)" :logos="previewLogos" />
			</div>
		</UiQueryBoundary>

		<BrandKitImportDialog v-model:open="isImportOpen" @apply="applyImport" />

		<UnsavedChangesDialog
			:show="unsavedDialog.showDialog"
			:saving="unsavedDialog.isSavingBeforeLeave"
			@close="unsavedDialog.cancelNavigation"
			@discard="unsavedDialog.confirmDiscard"
			@save="unsavedDialog.confirmSave"
		/>
	</div>
</template>
