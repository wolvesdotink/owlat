<script setup lang="ts">
/**
 * THE RAMP, ON THE PAGE PEOPLE ACTUALLY OPEN.
 *
 * Four operator-grade screens sit over the ramp controller and the main
 * deliverability page never mentioned it: an operator whose share moved
 * overnight had no sentence anywhere telling them so, and nothing pointing at
 * the screens that explain it. This card is that sentence — where the ramp is,
 * what the controller last decided and why, the one move worth making, and four
 * doors into the detail.
 *
 * SELF-QUERYING, like the reference-relay notice and for the same reason: what
 * the ramp is doing belongs to the DEPLOYMENT rather than to whatever the host
 * page happens to have loaded, and the host page keeps to one tag. The read is
 * the controls screen's own `getRampControls`, so this card and the advanced
 * screens can never quote different shares.
 *
 * ITS OWN BOUNDARY, because every empty state below is GOOD NEWS. "No cell is on
 * the ramp yet", "nothing needs you right now" and "the controller has not
 * decided anything yet" are all claims about a healthy deployment, and a read
 * that never answered has no standing to make any of them.
 */
import { api } from '@owlat/api';
import {
	rampAdvancedScreens,
	rampNextAction,
	rampPhaseNarrative,
	recentRampDecisions,
} from '~/utils/deliverabilityRampNarrative';
import { formatShortDate } from '~/utils/formatters';

const {
	data: controls,
	isLoading,
	error,
	refetch,
} = useOrganizationQuery(api.delivery.rampControlQueries.getRampControls);

const { t, locale } = useI18n();

/**
 * The narrative in `utils/deliverabilityRampNarrative` carries i18n keys rather
 * than sentences (the registry convention for module-scope definitions); a plain
 * string is still accepted so a value with nothing to translate reads as itself.
 */
type LocalizedText = string | { key: string; params?: Record<string, unknown> };
function localized(value: LocalizedText): string {
	return typeof value === 'string' ? t(value) : t(value.key, value.params ?? {});
}

const phaseHeadingId = useId();
const decisionsHeadingId = useId();
const actionHeadingId = useId();
const screensHeadingId = useId();

const phase = computed(() => (controls.value ? rampPhaseNarrative(controls.value) : null));
const decisions = computed(() => (controls.value ? recentRampDecisions(controls.value) : []));
const action = computed(() => (controls.value ? rampNextAction(controls.value) : null));
const screens = computed(() => rampAdvancedScreens(controls.value?.isRelayConfigured ?? false));

/** The meter's width, rounded once so the bar and its label cannot disagree. */
const progressPercent = computed(() =>
	phase.value?.progress ? Math.round(phase.value.progress.fraction * 100) : 0
);
</script>

<template>
	<UiCard id="deliverability-ramp-narrative" padding="none" overflow="hidden">
		<div class="border-b border-border-subtle bg-bg-surface px-5 py-3 sm:px-6">
			<p
				class="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-tertiary"
			>
				<Icon name="lucide:route" class="h-4 w-4" />
				{{ t('components.delivery.rampNarrativeCard.eyebrow') }}
			</p>
		</div>

		<div class="p-5 sm:p-6">
			<UiQueryBoundary
				:loading="isLoading"
				:error="error"
				:error-title="t('components.delivery.rampNarrativeCard.errorTitle')"
				:error-message="t('components.delivery.rampNarrativeCard.errorMessage')"
				@retry="refetch"
			>
				<template #loading>
					<div
						class="h-40 animate-pulse rounded-lg bg-bg-surface"
						role="status"
						aria-live="polite"
						:aria-label="t('components.delivery.rampNarrativeCard.loading')"
					/>
				</template>

				<div v-if="phase && action" class="space-y-6">
					<div>
						<!-- The phase IS this card's heading, exactly as the checklist's "Do
						     this next" card puts its item title under its own eyebrow: the
						     page owns the h1, so the card's own sections descend from here. -->
						<h2 :id="phaseHeadingId" class="text-xl font-semibold text-text-primary">
							{{ localized(phase.title) }}
						</h2>
						<p class="mt-1 text-sm leading-6 text-text-secondary" data-testid="ramp-phase-detail">
							{{ localized(phase.detail) }}
						</p>

						<!-- THE LABEL IS THE VALUE. The bar is decoration on top of a sentence
						     that says the same thing, so the progress survives both a screen
						     reader and a reader who cannot tell the two fills apart. -->
						<div v-if="phase.progress" class="mt-4">
							<div
								class="h-2 w-full overflow-hidden rounded-full bg-bg-surface"
								role="progressbar"
								:aria-labelledby="phaseHeadingId"
								:aria-valuemin="0"
								:aria-valuemax="100"
								:aria-valuenow="progressPercent"
								:aria-valuetext="localized(phase.progress.label)"
								data-testid="ramp-progress"
							>
								<div
									class="h-full rounded-full bg-brand"
									:style="{ width: `${progressPercent}%` }"
								/>
							</div>
							<p class="mt-1.5 text-xs text-text-tertiary" data-testid="ramp-progress-label">
								{{ localized(phase.progress.label) }}
							</p>
						</div>
					</div>

					<section :aria-labelledby="decisionsHeadingId">
						<h3 :id="decisionsHeadingId" class="text-sm font-semibold text-text-primary">
							{{ t('components.delivery.rampNarrativeCard.decisionsTitle') }}
						</h3>
						<p
							v-if="decisions.length === 0"
							class="mt-2 text-sm text-text-secondary"
							data-testid="ramp-narrative-no-decisions"
						>
							{{ t('components.delivery.rampNarrativeCard.noDecisions') }}
						</p>
						<ol v-else class="mt-2 space-y-3" data-testid="ramp-narrative-decisions">
							<li
								v-for="decision in decisions"
								:key="decision.key"
								class="border-l-2 border-border-subtle pl-3"
								:data-direction="decision.direction"
							>
								<p class="text-xs text-text-tertiary">
									<span class="font-medium text-text-secondary">
										{{ localized(decision.cellLabel) }}
									</span>
									·
									<time :datetime="new Date(decision.at).toISOString()">
										{{ formatShortDate(decision.at, locale) }}
									</time>
									·
									<span data-testid="ramp-narrative-direction">
										{{ localized(decision.directionLabel) }}
									</span>
									{{ decision.move }} · {{ localized(decision.reason) }}
								</p>
								<!-- The controller's own sentence, verbatim: re-wording it here
								     would let this card and the audit trail describe one decision
								     two different ways. -->
								<p class="text-sm text-text-primary">{{ decision.message }}</p>
								<p
									v-if="decision.notice !== null"
									class="mt-1 text-sm text-text-secondary"
									data-testid="ramp-narrative-notice"
								>
									{{ decision.notice }}
								</p>
							</li>
						</ol>
					</section>

					<section
						:aria-labelledby="actionHeadingId"
						class="rounded-lg border border-brand/20 bg-brand/5 p-4"
					>
						<h3 :id="actionHeadingId" class="text-sm font-semibold text-text-primary">
							{{ localized(action.title) }}
						</h3>
						<p
							v-if="action.detail"
							class="mt-1 text-sm leading-6 text-text-secondary"
							data-testid="ramp-next-action-detail"
						>
							{{ localized(action.detail) }}
						</p>
						<UiButton :to="action.to" class="mt-3" data-testid="ramp-next-action-cta">
							{{ localized(action.ctaLabel) }}
						</UiButton>
					</section>

					<nav :aria-labelledby="screensHeadingId" class="border-t border-border-subtle pt-4">
						<h3 :id="screensHeadingId" class="text-sm font-semibold text-text-primary">
							{{ t('components.delivery.rampNarrativeCard.goDeeper') }}
						</h3>
						<ul class="mt-2 grid gap-2 sm:grid-cols-2">
							<li v-for="screen in screens" :key="screen.to">
								<NuxtLink
									:to="screen.to"
									class="flex items-start gap-2 rounded-lg p-2 text-sm text-text-secondary transition-colors duration-(--motion-fast) hover:bg-bg-surface hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
								>
									<Icon :name="screen.icon" class="mt-0.5 h-4 w-4 shrink-0" />
									<span>
										<span class="font-medium text-text-primary">
											{{ localized(screen.label) }}
										</span>
										<span class="block text-xs text-text-tertiary">
											{{ localized(screen.description) }}
										</span>
									</span>
								</NuxtLink>
							</li>
						</ul>
					</nav>
				</div>
			</UiQueryBoundary>
		</div>
	</UiCard>
</template>
