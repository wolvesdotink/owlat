<script setup lang="ts">
/**
 * The IMAP/SMTP server fields of the mailbox connect form, behind the
 * "advanced" disclosure.
 *
 * Split out of `PostboxMailboxConnectForm.vue` to keep that file under the
 * 500-line cap once the Google sign-in branch landed. Purely the six server
 * fields plus the username — no submit, no validation, no backend call.
 *
 * Raw `input` elements rather than `UiInput` on purpose: a native `input` event
 * must fire only on real typing, so a programmatic autodiscover fill cannot
 * mark the fields "touched" and switch autofill off. `touched` is the parent's
 * signal for exactly that.
 */
import type { MailPreset } from '~/utils/mailAutodiscover';

/**
 * The fields this component edits. A single object model (like
 * `HostnameOverrides`) rather than seven `v-model`s: the parent already keeps
 * them in one reactive form object, and the preset shape is shared.
 */
export type MailServerFields = MailPreset & { username: string };

const fields = defineModel<MailServerFields>({ required: true });
/** Disclosure open state, owned by the parent (update mode opens it). */
const open = defineModel<boolean>('open', { required: true });

const emit = defineEmits<{
	/** A real edit happened — the parent stops autofilling these fields. */
	(e: 'touched'): void;
}>();

const { t } = useI18n();
</script>

<template>
	<UiDisclosure
		v-model="open"
		controls="mail-server-settings"
		:label="t('components.postbox.postboxMailboxConnectForm.advancedSettings')"
	>
		<div class="space-y-4">
			<div class="grid grid-cols-2 gap-4">
				<div>
					<label for="connect-imaphost" class="text-sm font-medium block mb-1">{{
						t('components.postbox.postboxMailboxConnectForm.imapHost')
					}}</label>
					<input
						id="connect-imaphost"
						v-model="fields.imapHost"
						type="text"
						:placeholder="t('components.postbox.postboxMailboxConnectForm.imapHostPlaceholder')"
						class="input w-full"
						@input="emit('touched')"
					/>
				</div>
				<div class="flex gap-2">
					<div class="flex-1">
						<label for="connect-imapport" class="text-sm font-medium block mb-1">{{
							t('components.postbox.postboxMailboxConnectForm.imapPort')
						}}</label>
						<input
							id="connect-imapport"
							v-model.number="fields.imapPort"
							type="number"
							class="input w-full"
							@input="emit('touched')"
						/>
					</div>
					<label class="flex items-center gap-1.5 text-sm self-end pb-2">
						<input
							v-model="fields.isImapSecure"
							type="checkbox"
							@change="emit('touched')"
						/>
						{{ t('components.postbox.postboxMailboxConnectForm.ssl') }}
					</label>
				</div>
			</div>
			<div class="grid grid-cols-2 gap-4">
				<div>
					<label for="connect-smtphost" class="text-sm font-medium block mb-1">{{
						t('components.postbox.postboxMailboxConnectForm.smtpHost')
					}}</label>
					<input
						id="connect-smtphost"
						v-model="fields.smtpHost"
						type="text"
						:placeholder="t('components.postbox.postboxMailboxConnectForm.smtpHostPlaceholder')"
						class="input w-full"
						@input="emit('touched')"
					/>
				</div>
				<div class="flex gap-2">
					<div class="flex-1">
						<label for="connect-smtpport" class="text-sm font-medium block mb-1">{{
							t('components.postbox.postboxMailboxConnectForm.smtpPort')
						}}</label>
						<input
							id="connect-smtpport"
							v-model.number="fields.smtpPort"
							type="number"
							class="input w-full"
							@input="emit('touched')"
						/>
					</div>
					<label class="flex items-center gap-1.5 text-sm self-end pb-2">
						<input
							v-model="fields.isSmtpSecure"
							type="checkbox"
							@change="emit('touched')"
						/>
						{{ t('components.postbox.postboxMailboxConnectForm.ssl') }}
					</label>
				</div>
			</div>
			<div>
				<label for="connect-username" class="text-sm font-medium block mb-1">{{
					t('components.postbox.postboxMailboxConnectForm.username')
				}}</label>
				<input
					id="connect-username"
					v-model="fields.username"
					type="text"
					:placeholder="t('components.postbox.postboxMailboxConnectForm.usernamePlaceholder')"
					class="input w-full"
				/>
			</div>
		</div>
	</UiDisclosure>
</template>
