<script setup lang="ts">
// The contact page's "Contact details" card: email, name, timezone and
// language, read-only or as inputs while the page is editing.
import { GlobeIcon, MailIcon, TranslateIcon, UserIcon } from '@coolicons/vue';

defineProps<{
	contact: {
		email?: string;
		firstName?: string;
		lastName?: string;
		timezone?: string;
		language?: string;
	};
	isEditing: boolean;
	/** The page's edit draft; the inputs write into it in place. */
	form: { email: string; firstName: string; lastName: string; timezone: string; language: string };
	timezones: ReadonlyArray<{ value: string; label: string }>;
	languages: ReadonlyArray<{ value: string; label: string }>;
	timezoneLabel: string;
	languageLabel: string;
}>();

const { t } = useI18n();
</script>

<template>
	<div class="card">
		<h2 class="text-lg font-medium text-text-primary mb-4">
			{{ t('dashboard.audience.contacts.detail.contactDetails') }}
		</h2>

		<!-- Two columns once the main column is wide, so a label and its
		     value stay close instead of floating in a 1000px card. -->
		<div class="grid gap-4 2xl:grid-cols-2 2xl:gap-x-8">
			<!-- Email -->
			<div>
				<label class="label">{{ t('dashboard.audience.contacts.detail.fields.email') }}</label>
				<div v-if="isEditing" class="flex items-center gap-3">
					<MailIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<input
						v-model="form.email"
						type="email"
						class="input"
						:placeholder="t('dashboard.audience.contacts.detail.fields.emailPlaceholder')"
					/>
				</div>
				<div v-else class="flex items-center gap-3 py-2">
					<MailIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<span class="text-text-primary">{{ contact.email }}</span>
				</div>
			</div>

			<!-- First Name -->
			<div>
				<label class="label">{{ t('dashboard.audience.contacts.detail.fields.firstName') }}</label>
				<div v-if="isEditing" class="flex items-center gap-3">
					<UserIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<input
						v-model="form.firstName"
						type="text"
						class="input"
						:placeholder="t('dashboard.audience.contacts.detail.fields.firstNamePlaceholder')"
					/>
				</div>
				<div v-else class="flex items-center gap-3 py-2">
					<UserIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<span :class="contact.firstName ? 'text-text-primary' : 'text-text-tertiary'">
						{{ contact.firstName || t('dashboard.audience.contacts.detail.notSet') }}
					</span>
				</div>
			</div>

			<!-- Last Name -->
			<div>
				<label class="label">{{ t('dashboard.audience.contacts.detail.fields.lastName') }}</label>
				<div v-if="isEditing" class="flex items-center gap-3">
					<UserIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<input
						v-model="form.lastName"
						type="text"
						class="input"
						:placeholder="t('dashboard.audience.contacts.detail.fields.lastNamePlaceholder')"
					/>
				</div>
				<div v-else class="flex items-center gap-3 py-2">
					<UserIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<span :class="contact.lastName ? 'text-text-primary' : 'text-text-tertiary'">
						{{ contact.lastName || t('dashboard.audience.contacts.detail.notSet') }}
					</span>
				</div>
			</div>

			<!-- Timezone -->
			<div>
				<label class="label">{{ t('dashboard.audience.contacts.detail.fields.timezone') }}</label>
				<div v-if="isEditing" class="flex items-center gap-3">
					<GlobeIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<select v-model="form.timezone" class="input">
						<option v-for="tz in timezones" :key="tz.value" :value="tz.value">
							{{ tz.label }}
						</option>
					</select>
				</div>
				<div v-else class="flex items-center gap-3 py-2">
					<GlobeIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<span :class="contact.timezone ? 'text-text-primary' : 'text-text-tertiary'">
						{{ timezoneLabel }}
					</span>
				</div>
			</div>

			<!-- Language -->
			<div>
				<label class="label">{{ t('dashboard.audience.contacts.detail.fields.language') }}</label>
				<div v-if="isEditing" class="flex items-center gap-3">
					<TranslateIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<select v-model="form.language" class="input">
						<option v-for="lang in languages" :key="lang.value" :value="lang.value">
							{{ lang.label }}
						</option>
					</select>
				</div>
				<div v-else class="flex items-center gap-3 py-2">
					<TranslateIcon class="w-5 h-5 text-text-tertiary flex-shrink-0" />
					<span :class="contact.language ? 'text-text-primary' : 'text-text-tertiary'">
						{{ languageLabel }}
					</span>
				</div>
			</div>
		</div>
	</div>
</template>
