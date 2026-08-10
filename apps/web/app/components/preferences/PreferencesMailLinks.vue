<script setup lang="ts">
const { isEnabled } = useFeatureFlag();
</script>

<template>
	<nav class="grid grid-cols-2 gap-3 mb-6" aria-label="Mail preferences">
		<NuxtLink
			v-if="isEnabled('mail.external')"
			to="/dashboard/postbox/migrate"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3 border-brand/30"
		>
			<Icon name="lucide:mail" class="w-5 h-5 text-brand" />
			<div>
				<p class="font-medium text-sm">Import your mail</p>
				<p class="text-xs text-text-tertiary">
					Gmail, Fastmail, Outlook or any mail provider + teach your AI
				</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/filters"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:filter" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">Filters</p>
				<p class="text-xs text-text-tertiary">Auto-route inbound mail</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/aliases"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:at-sign" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">Aliases</p>
				<p class="text-xs text-text-tertiary">Alternate addresses</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/forwarding"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:forward" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">Forwarding</p>
				<p class="text-xs text-text-tertiary">External forwarding rules</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/vacation"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:plane" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">Vacation</p>
				<p class="text-xs text-text-tertiary">Auto-reply while away</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/signatures"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:signature" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">Signatures</p>
				<p class="text-xs text-text-tertiary">Auto-append to new drafts</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/snippets"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:text-quote" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">Snippets</p>
				<p class="text-xs text-text-tertiary">Canned responses via "/"</p>
			</div>
		</NuxtLink>
		<NuxtLink
			v-if="isEnabled('ai')"
			to="/dashboard/preferences/writing-voice"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:wand-sparkles" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">Writing voice</p>
				<p class="text-xs text-text-tertiary">Make AI drafts sound like you</p>
			</div>
		</NuxtLink>
		<NuxtLink
			to="/dashboard/preferences/app-passwords"
			class="card !p-4 hover:bg-bg-surface flex items-center gap-3"
		>
			<Icon name="lucide:key-round" class="w-5 h-5 text-text-secondary" />
			<div>
				<p class="font-medium text-sm">App passwords</p>
				<p class="text-xs text-text-tertiary">For Apple Mail / Thunderbird</p>
			</div>
		</NuxtLink>
	</nav>
</template>
