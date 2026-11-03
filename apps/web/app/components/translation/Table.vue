<script setup lang="ts">
/**
 * The translation manager's grid: one row per translatable field, the default
 * language read-only, one editable column per translation, and the column
 * actions (auto-translate, remove, add a language). It renders and emits; the
 * manager owns the drafts and every write.
 */
import type { LanguageOption } from '~/data/languageOptions';
import type { TranslationCellStatus } from '~/composables/useTranslationDrafts';
import type { TranslatableRow } from '~/utils/translationRows';
import TranslationCell from './Cell.vue';
import { GlobeIcon, PlusIcon, SparklesIcon, TrashIcon } from '@coolicons/vue';

defineProps<{
	rows: TranslatableRow[];
	defaultLanguage: string;
	/** The non-default languages, one column each. */
	languages: string[];
	/** Languages that can still be added. */
	availableLanguages: LanguageOption[];
	/** The language being auto-translated, if any. */
	translatingLanguage: string | null;
	isSaving: boolean;
	/** A language's own name for itself, the column heading. */
	nativeLabelOf: (language: string) => string;
	cellValue: (row: TranslatableRow, language: string) => string;
	cellStatus: (row: TranslatableRow, language: string) => TranslationCellStatus;
}>();

const emit = defineEmits<{
	autoTranslate: [language: string];
	removeLanguage: [language: string];
	addLanguage: [language: string];
	save: [row: TranslatableRow, language: string, value: string];
	retry: [row: TranslatableRow, language: string];
	discard: [row: TranslatableRow, language: string];
	edit: [row: TranslatableRow, language: string, text: string | null];
}>();

const { t } = useI18n();

// Dropdown state for add language
const addLanguageDropdownOpen = ref(false);
</script>

<template>
	<div class="rounded-(--radius-card) surface-2 overflow-hidden">
		<div class="overflow-x-auto">
			<table class="w-full">
				<thead>
					<tr class="border-b border-border-subtle bg-bg-surface/50">
						<!-- Field column -->
						<th
							class="px-4 py-3 text-left text-sm font-medium text-text-secondary sticky left-0 bg-bg-surface/50 min-w-[200px]"
						>
							{{ t('components.translation.manager.fieldColumn') }}
						</th>

						<!-- Default language column -->
						<th class="px-4 py-3 text-left text-sm font-medium text-text-secondary min-w-[250px]">
							<div class="flex items-center gap-2">
								<span>{{ nativeLabelOf(defaultLanguage) }}</span>
								<span class="text-xs text-brand bg-brand/10 px-1.5 py-0.5 rounded">{{
									t('components.translation.manager.defaultBadge')
								}}</span>
							</div>
						</th>

						<!-- Translation language columns -->
						<th
							v-for="lang in languages"
							:key="lang"
							class="px-4 py-3 text-left text-sm font-medium text-text-secondary min-w-[250px]"
						>
							<div class="flex items-center justify-between">
								<span>{{ nativeLabelOf(lang) }}</span>
								<div class="flex items-center gap-1">
									<UiTooltip
										v-if="translatingLanguage !== lang"
										:text="t('components.translation.manager.autoTranslateTitle')"
									>
										<button
											class="p-1 rounded hover:bg-brand/10 text-text-tertiary hover:text-brand transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											:aria-label="t('components.translation.manager.autoTranslateTitle')"
											@click="emit('autoTranslate', lang)"
										>
											<SparklesIcon class="w-4 h-4" />
										</button>
									</UiTooltip>
									<UiSpinner v-else size="xs" />
									<UiTooltip :text="t('components.translation.manager.removeLanguageTitle')">
										<button
											class="p-1 rounded hover:bg-error/10 text-text-tertiary hover:text-error transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
											:aria-label="t('components.translation.manager.removeLanguageTitle')"
											@click="emit('removeLanguage', lang)"
										>
											<TrashIcon class="w-4 h-4" />
										</button>
									</UiTooltip>
								</div>
							</div>
						</th>

						<!-- Add language column -->
						<th class="px-4 py-3 text-left text-sm font-medium text-text-secondary min-w-[150px]">
							<UiDropdownMenu
								v-if="availableLanguages.length > 0"
								v-model:open="addLanguageDropdownOpen"
							>
								<template #trigger>
									<UiButton variant="outline" size="sm" :disabled="isSaving">
										<PlusIcon class="w-4 h-4" />
										{{ t('components.translation.manager.addLanguage') }}
									</UiButton>
								</template>

								<UiDropdownMenuItem
									v-for="lang in availableLanguages"
									:key="lang.value"
									@click="emit('addLanguage', lang.value)"
								>
									<GlobeIcon class="w-4 h-4" />
									{{
										t('components.translation.manager.languageOption', {
											label: t(lang.label),
											nativeLabel: t(lang.nativeLabel),
										})
									}}
								</UiDropdownMenuItem>
							</UiDropdownMenu>
						</th>
					</tr>
				</thead>

				<tbody>
					<tr
						v-for="row in rows"
						:key="row.id"
						class="border-b border-border-subtle last:border-b-0 hover:bg-bg-surface/30 transition-colors"
					>
						<!-- Field label -->
						<td
							class="px-4 py-3 text-sm text-text-secondary sticky left-0 bg-bg-elevated font-medium"
						>
							{{ row.label }}
							<span
								v-if="row.fieldType === 'html'"
								class="ml-1.5 text-xs text-text-tertiary bg-bg-surface px-1 py-0.5 rounded"
							>
								{{ t('components.translation.manager.htmlBadge') }}
							</span>
						</td>

						<!-- Default language cell (read-only) -->
						<td class="px-4 py-3">
							<TranslationCell
								:value="row.sourceText"
								:is-html="row.fieldType === 'html'"
								:is-default="true"
							/>
						</td>

						<!-- Translation cells -->
						<td v-for="lang in languages" :key="lang" class="px-4 py-3">
							<TranslationCell
								:value="cellValue(row, lang)"
								:is-html="row.fieldType === 'html'"
								:status="cellStatus(row, lang)"
								:field-label="row.label"
								:language-label="nativeLabelOf(lang)"
								@save="(value: string) => emit('save', row, lang, value)"
								@retry="emit('retry', row, lang)"
								@discard="emit('discard', row, lang)"
								@edit="(text: string | null) => emit('edit', row, lang, text)"
							/>
						</td>

						<!-- Empty cell for add column -->
						<td class="px-4 py-3" />
					</tr>
				</tbody>
			</table>
		</div>
	</div>
</template>
