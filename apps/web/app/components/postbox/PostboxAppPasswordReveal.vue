<script setup lang="ts">
const props = defineProps<{
	open: boolean;
	password: string | null;
	label: string | null;
}>();

const emit = defineEmits<{
	(e: 'update:open', value: boolean): void;
}>();

const { t } = useI18n();

const { copy, copiedKey } = useCopyToClipboard();
const copied = computed(() => copiedKey.value === 'app-password');

async function copyPassword() {
	if (!props.password) return;
	await copy(props.password, 'app-password');
}

function close() {
	emit('update:open', false);
}
</script>

<template>
	<UiModal :open="open && !!password" size="md" @update:open="emit('update:open', $event)">
		<div v-if="password">
			<header class="flex items-start gap-3 mb-4">
				<div
					class="w-9 h-9 rounded-full bg-warning/10 text-warning flex items-center justify-center flex-shrink-0"
				>
					<Icon name="lucide:key-round" class="w-5 h-5" />
				</div>
				<div class="flex-1">
					<h2 class="text-lg font-semibold">
						{{ t('components.postbox.appPasswordReveal.title') }}
					</h2>
					<I18nT
						keypath="components.postbox.appPasswordReveal.body"
						tag="p"
						scope="global"
						class="text-sm text-text-secondary mt-0.5"
					>
						<template #client>
							<strong>{{ label || t('components.postbox.appPasswordReveal.yourClient') }}</strong>
						</template>
					</I18nT>
				</div>
			</header>

			<div
				class="p-3 rounded border border-border-subtle bg-bg-base font-mono tracking-wider text-lg text-center select-all"
			>
				{{ password }}
			</div>

			<div class="flex items-center justify-between mt-4">
				<UiButton variant="ghost" type="button" @click="copyPassword">
					<Icon :name="copied ? 'lucide:check' : 'lucide:copy'" class="w-4 h-4 mr-1.5" />
					{{ copied ? t('common.copied') : t('common.copy') }}
				</UiButton>
				<UiButton type="button" @click="close">{{
					t('components.postbox.appPasswordReveal.saved')
				}}</UiButton>
			</div>
		</div>
	</UiModal>
</template>
