<script setup lang="ts">
/**
 * Sign-in and security (plan idea 57).
 *
 * The account page has only ever offered a password change, while the auth
 * schema has carried session IP/user-agent and a two-factor table the whole
 * time. This is where those become visible and revocable.
 *
 * Order is deliberate: sessions first, because "is someone else signed in?" is
 * the question a person opens a security page with, and two-factor second,
 * because it is the thing they do about it.
 */
import { useAccountSessions } from '~/composables/useAccountSecurity';
import { describeLastSeen, type ActiveSessionRow } from '~/utils/accountSessions';
import type { LocalizedText } from '~/utils/readinessGate';

const { t, locale } = useI18n();

useHead({ title: () => t('dashboard.preferences.security.pageTitle') });

definePageMeta({
	layout: 'preferences',
	middleware: 'auth',
});

const { currentSession } = useAuth();
const { showToast } = useToast();

/** Descriptors from the pure modules are resolved here, at the render boundary. */
function say(text: LocalizedText): string {
	return typeof text === 'string' ? text : t(text.key, text.params ?? {});
}

// ── Sessions ──────────────────────────────────────────────────────────────

const { sessions, otherSessionCount, isLoading, hasLoadError, refresh, revoke, revokeOthers } =
	useAccountSessions(() => currentSession.value?.token ?? null);

onMounted(refresh);

/**
 * A ticking clock, so "3 min ago" does not sit frozen on a page people leave
 * open. One interval for the whole list; the descriptors are pure functions of
 * it, so nothing else has to know that time passed.
 */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	clock = setInterval(() => {
		now.value = Date.now();
	}, 30_000);
});
onUnmounted(() => {
	if (clock) clearInterval(clock);
});

function absoluteDate(timestamp: number): string {
	return new Intl.DateTimeFormat(locale.value, {
		dateStyle: 'medium',
		timeStyle: 'short',
	}).format(timestamp);
}

/** Relative inside a week, absolute past it — see `describeLastSeen`. */
function lastSeenLabel(row: ActiveSessionRow): string {
	const relative = describeLastSeen(row.lastSeenAt, now.value);
	return relative ? say(relative) : absoluteDate(row.lastSeenAt);
}

const sessionToRevoke = ref<ActiveSessionRow | null>(null);
const isRevoking = ref(false);

async function confirmRevoke() {
	const target = sessionToRevoke.value;
	if (!target) return;
	isRevoking.value = true;
	try {
		const result = await revoke(target.token);
		if (result.ok) showToast(t('dashboard.preferences.security.sessions.revoked'));
		else showToast(t('dashboard.preferences.security.sessions.revokeFailed'), 'error');
	} finally {
		isRevoking.value = false;
		sessionToRevoke.value = null;
	}
}

const showSignOutOthers = ref(false);
const isSigningOutOthers = ref(false);

async function confirmSignOutOthers() {
	isSigningOutOthers.value = true;
	try {
		const result = await revokeOthers();
		if (result.ok) showToast(t('dashboard.preferences.security.sessions.signedOutOthers'));
		else showToast(t('dashboard.preferences.security.sessions.signOutOthersFailed'), 'error');
	} finally {
		isSigningOutOthers.value = false;
		showSignOutOthers.value = false;
	}
}
</script>

<template>
	<div>
		<header class="mb-6">
			<p class="text-text-secondary">
				{{ t('dashboard.preferences.security.subheading') }}
			</p>
		</header>

		<!-- ── Active sessions ── -->
		<section class="card !p-0 mb-6">
			<header class="px-5 py-3 border-b border-border-subtle flex items-center justify-between">
				<div>
					<h2 class="font-semibold">
						{{ t('dashboard.preferences.security.sessions.heading') }}
					</h2>
					<p class="text-xs text-text-tertiary mt-0.5">
						{{ t('dashboard.preferences.security.sessions.description') }}
					</p>
				</div>
				<UiButton
					variant="ghost"
					type="button"
					:disabled="otherSessionCount === 0"
					@click="showSignOutOthers = true"
				>
					{{ t('dashboard.preferences.security.sessions.signOutOthers') }}
				</UiButton>
			</header>

			<div v-if="isLoading" class="p-8 flex justify-center">
				<Icon name="lucide:loader-2" class="w-5 h-5 animate-spin text-text-tertiary" />
			</div>
			<p v-else-if="hasLoadError" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.security.sessions.loadFailed') }}
			</p>
			<p v-else-if="sessions.length === 0" class="p-8 text-center text-text-secondary">
				{{ t('dashboard.preferences.security.sessions.empty') }}
			</p>
			<ul v-else class="divide-y divide-border-subtle">
				<li
					v-for="row in sessions"
					:key="row.id"
					class="px-5 py-3 flex items-center justify-between gap-4"
				>
					<div class="flex items-start gap-3 min-w-0">
						<Icon :name="row.icon" class="w-5 h-5 text-text-tertiary shrink-0 mt-0.5" />
						<div class="min-w-0">
							<p class="font-medium text-sm flex items-center gap-2 flex-wrap">
								<span>{{ say(row.browser) }}</span>
								<span class="text-text-tertiary font-normal">{{ say(row.platform) }}</span>
								<span
									v-if="row.isCurrent"
									class="text-xs px-1.5 py-0.5 rounded bg-success-subtle text-success"
								>
									{{ t('dashboard.preferences.security.sessions.currentBadge') }}
								</span>
							</p>
							<p class="text-xs text-text-tertiary mt-0.5">
								{{
									row.ipAddress
										? t('dashboard.preferences.security.sessions.ipLabel', {
												address: row.ipAddress,
											})
										: t('dashboard.preferences.security.sessions.ipUnknown')
								}}
								·
								{{
									t('dashboard.preferences.security.sessions.lastSeenLabel', {
										when: lastSeenLabel(row),
									})
								}}
							</p>
							<p class="text-xs text-text-tertiary">
								{{
									t('dashboard.preferences.security.sessions.signedInSince', {
										date: absoluteDate(row.createdAt),
									})
								}}
							</p>
						</div>
					</div>
					<UiButton
						v-if="!row.isCurrent"
						variant="ghost"
						type="button"
						class="text-error shrink-0"
						@click="sessionToRevoke = row"
					>
						{{ t('dashboard.preferences.security.sessions.revoke') }}
					</UiButton>
				</li>
			</ul>
		</section>

		<!--
			Two-factor lives in its own component: it is a three-step enrolment with
			its own dialogs, and it only touches this page when confirming a code
			rotates the session — which is exactly what the event says.
		-->
		<PreferencesTwoFactor @sessions-changed="refresh" />

		<UiConfirmationDialog
			:open="sessionToRevoke !== null"
			variant="danger"
			:title="t('dashboard.preferences.security.sessions.revokeDialogTitle')"
			:description="t('dashboard.preferences.security.sessions.revokeDialogDescription')"
			:confirm-text="t('dashboard.preferences.security.sessions.revokeConfirm')"
			:is-loading="isRevoking"
			@update:open="(open: boolean) => !open && (sessionToRevoke = null)"
			@confirm="confirmRevoke"
		/>

		<UiConfirmationDialog
			:open="showSignOutOthers"
			variant="danger"
			:title="t('dashboard.preferences.security.sessions.signOutOthersDialogTitle')"
			:description="t('dashboard.preferences.security.sessions.signOutOthersDialogDescription')"
			:confirm-text="t('dashboard.preferences.security.sessions.signOutOthersConfirm')"
			:is-loading="isSigningOutOthers"
			@update:open="(open: boolean) => (showSignOutOthers = open)"
			@confirm="confirmSignOutOthers"
		/>
	</div>
</template>
