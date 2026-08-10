<script setup lang="ts">
/**
 * INDEPENDENCE — the screen people screenshot (plan D2, D14, P3-6).
 *
 * One percentage of mail now sent from your own server, the trend behind it, the
 * projected date you stop paying, and the spend that replaces. Every number is
 * the server's, derived by the same pure arithmetic this page imports, so the
 * figure an operator puts in front of their boss is the figure the controller is
 * acting on.
 *
 * WITH NO RELAY IT IS A DIFFERENT FEATURE, NOT A DEGRADED ONE (plan D14). The
 * headline becomes "Warm-up autopilot", the number becomes today's capacity, and
 * the independence projection is `already_independent` — because there is
 * nothing to become independent OF. Nothing on this screen is a warning, an
 * error, or a "setup incomplete" nag in that configuration; a fresh install with
 * only an MTA renders every field here (plan D2).
 *
 * DISCONNECTING THE RELAY BELOW GRADUATION IS THE ONE DANGEROUS ROUTE OFF THIS
 * PAGE, and it names its consequence: which cells are still leaning on the
 * relay, and the date they would be safe. Pulling the relay does not move that
 * traffic gently — it moves all of it at once, which is the exact failure the
 * ramp exists to avoid.
 */
import { api } from '@owlat/api';
import { RELAY_REMOVAL_CONFIRMATION } from '@owlat/shared/deliverabilityIndependence';
import { relayRemovalConsequenceCopy, shareLabel } from '~/utils/deliverabilityRamp';
import {
	capacityCopy,
	independenceHeadline,
	independenceSubhead,
	projectionCopy,
	spendAvoidedCopy,
	volumeSentence,
} from '~/utils/deliverabilityIndependenceCopy';
import { formatNumber, formatShortDate } from '~/utils/formatters';

definePageMeta({ layout: 'dashboard', middleware: ['auth', 'admin'] });

const {
	data: summary,
	isLoading,
	error,
} = useOrganizationQuery(api.delivery.rampIndependence.getIndependenceSummary);

/**
 * THE NAME OF THE RELAY, and separately WHETHER THERE IS ONE (#513).
 *
 * `referenceTransportId` is null on two different deployments — no relay, and
 * more than one kind of relay — so every branch on this screen that decides
 * WHICH FEATURE this is keys on `isRelayConfigured` instead. The id is passed
 * only where a name is wanted, and the shared copy words its null as "the
 * relay(s)" rather than reverting to the standalone sentence.
 */
const referenceTransportId = computed<string | null>(
	() => summary.value?.referenceTransportId ?? null
);
// The `?? false` keeps the pre-arrival framing exactly where it was: the header
// renders before the summary does, and the standalone wording is the one the
// page has always shown for the moment it knows nothing.
const isRelayConfigured = computed(() => summary.value?.isRelayConfigured ?? false);
const isStandalone = computed(() => !isRelayConfigured.value);
const headline = computed(() => independenceHeadline(isRelayConfigured.value));
// THE TAB TITLE FOLLOWS THE H1. A static "Sending independence" would leave a
// standalone deployment reading "Warm-up autopilot" on the page and something
// else in its browser tab — the D14 rename half-applied.
useHead(computed(() => ({ title: `${headline.value} — Owlat` })));
const chartHeadingId = useId();

/**
 * THE HEADLINE NUMBER. `null` means nothing has been sent in the window — a fact
 * about a young account, not a measurement failure, so it reads as a dash with a
 * sentence beside it rather than as 0%.
 */
const headlineValue = computed(() => {
	const data = summary.value;
	if (data === undefined) return '—';
	if (isStandalone.value) {
		// The same formatting as the sentence under it (`capacityCopy`): a headline
		// reading "4000" above a note reading "4,000 more messages" looks like two
		// different figures on the screen people screenshot.
		return data.capacity.remainingToday === null ? '—' : formatNumber(data.capacity.remainingToday);
	}
	return data.ownShare === null ? '—' : shareLabel(data.ownShare);
});

const isRemovalDialogOpen = ref(false);

/**
 * `null` while the summary has not arrived, `[]` once it has and every cell has
 * graduated. Two different facts, and the consequence copy renders them as two
 * different sentences — collapsing them put "this cannot be treated as safe" in
 * the dialog of a deployment whose card, two lines above the button that opens
 * it, said every cell had graduated.
 */
const dependentCells = computed<readonly string[] | null>(() => {
	const removal = summary.value?.relayRemoval;
	if (removal === undefined) return null;
	return removal.kind === 'safe' ? [] : removal.dependentCells;
});

const isRemovalSafe = computed(() => summary.value?.relayRemoval.kind === 'safe');

const projectedSafeAt = computed(() => {
	const removal = summary.value?.relayRemoval;
	return removal === undefined || removal.kind === 'safe' ? null : removal.projectedSafeAt;
});

/**
 * The consequence sentence is the SHARED one — the transport editor's dialog and
 * the endpoint's refusal build theirs from the same helper, so an operator who
 * reads it here and then meets it again on the screen that actually disconnects
 * cannot be told two different stakes for one click. THE CARD AND THE DIALOG ON
 * THIS SCREEN RENDER THE SAME STRING for the same reason: the button sits below
 * the card, and a second hand-written sentence in the dialog is the shortest
 * distance to two claims about one click.
 */
const removalConsequence = computed(() =>
	relayRemovalConsequenceCopy({
		dependentCells: dependentCells.value,
		referenceTransportId: referenceTransportId.value,
		projectedSafeAt: projectedSafeAt.value,
	})
);

function confirmRelayRemoval(): void {
	isRemovalDialogOpen.value = false;
	// THIS ROUTE ONLY NAVIGATES, and it is not what makes the removal safe: the
	// change itself happens on the config screen, whose apply path opens this same
	// dialog and whose endpoint re-checks the phrase server-side. The typed phrase
	// here is what stops "Disconnect the relay…" reading as a menu item.
	void navigateTo('/dashboard/admin/delivery/transport');
}
</script>

<template>
	<div class="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
		<header class="mb-6">
			<h1 class="text-2xl font-semibold text-text-primary">{{ headline }}</h1>
			<p class="mt-1 max-w-2xl text-sm text-text-secondary">
				{{ independenceSubhead({ isRelayConfigured, referenceTransportId }) }}
			</p>
		</header>

		<UiQueryBoundary
			:loading="isLoading"
			:error="error"
			error-title="Couldn’t load your independence figures"
			error-message="These numbers could not be loaded. Your mail is unaffected — this page only reads."
		>
			<template #loading>
				<div
					class="space-y-5"
					role="status"
					aria-live="polite"
					aria-label="Loading independence figures"
				>
					<div class="h-32 animate-pulse rounded-xl bg-bg-surface" />
					<div class="h-44 animate-pulse rounded-xl bg-bg-surface" />
				</div>
			</template>

			<div v-if="summary" class="space-y-5">
				<UiCard>
					<p class="text-sm text-text-secondary">
						{{ isStandalone ? 'Messages you can still send today' : 'Sent from your own server' }}
					</p>
					<p
						class="mt-1 text-4xl font-semibold text-text-primary"
						data-testid="independence-headline"
					>
						{{ headlineValue }}
					</p>
					<p class="mt-2 text-sm text-text-secondary" data-testid="independence-headline-note">
						{{ isStandalone ? capacityCopy(summary) : volumeSentence(summary) }}
					</p>
				</UiCard>

				<UiCard>
					<h2 :id="chartHeadingId" class="text-base font-semibold text-text-primary">
						Daily sending
					</h2>
					<DeliveryIndependenceTrendChart
						class="mt-3"
						:points="summary.series"
						:has-reference="!isStandalone"
						:labelled-by="chartHeadingId"
					/>
				</UiCard>

				<UiCard>
					<h2 class="text-base font-semibold text-text-primary">When you stop paying</h2>
					<p class="mt-2 text-sm text-text-secondary" data-testid="independence-projection">
						{{ projectionCopy(summary.projection) }}
					</p>
					<p class="mt-2 text-sm text-text-secondary" data-testid="independence-spend">
						{{ spendAvoidedCopy(summary) }}
					</p>
				</UiCard>

				<UiCard v-if="!isStandalone">
					<h2 class="text-base font-semibold text-text-primary">Disconnecting the relay</h2>
					<p
						v-if="isRemovalSafe"
						class="mt-2 text-sm text-text-secondary"
						data-testid="relay-removal-safe"
					>
						{{ removalConsequence.consequence }}
					</p>
					<template v-else>
						<p class="mt-2 text-sm text-text-secondary" data-testid="relay-removal-dependent">
							{{ removalConsequence.consequence }}
						</p>
						<p class="mt-1 text-sm text-text-secondary" data-testid="relay-removal-safe-date">
							{{
								projectedSafeAt === null
									? 'There is no projected safe date yet — the share is not advancing fast enough to give one.'
									: `On the current pace it would be safe to disconnect around ${formatShortDate(projectedSafeAt)}.`
							}}
						</p>
					</template>
					<button
						type="button"
						class="mt-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
						data-testid="relay-removal-open"
						@click="isRemovalDialogOpen = true"
					>
						Disconnect the relay…
					</button>
				</UiCard>
			</div>
		</UiQueryBoundary>

		<DeliveryRampConfirmDialog
			:open="isRemovalDialogOpen"
			title="Disconnect the relay?"
			:phrase="RELAY_REMOVAL_CONFIRMATION"
			confirm-label="Take me to the relay settings"
			@cancel="isRemovalDialogOpen = false"
			@confirm="confirmRelayRemoval"
		>
			<template #consequence>
				<p data-testid="relay-removal-consequence">{{ removalConsequence.consequence }}</p>
				<p v-if="removalConsequence.safeDate !== null" data-testid="relay-removal-dialog-date">
					{{ removalConsequence.safeDate }}
				</p>
			</template>
		</DeliveryRampConfirmDialog>
	</div>
</template>
