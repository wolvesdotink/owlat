<script setup lang="ts">
/**
 * Network ports — which of the ports this instance's features depend on are
 * actually open.
 *
 * A closed port does not look like a closed port from inside the app. It looks
 * like "connect an existing mailbox" hanging on a timeout, or sending halting
 * for no stated reason, and the operator has no way to tell that their VPS
 * provider — not Owlat — is dropping the traffic. This card asks the updater
 * (the only component with ordinary egress and the host `.env`) and names, per
 * port, the feature that stops working without it.
 *
 * The probes are NOT run on mount: each one opens a connection to a third
 * party, so it takes an operator pressing the button.
 */
import { apiFetch } from '~/lib/csrfFetch';
import {
	summarizePortChecks,
	type PortChecksVerdict,
	type SelectedPortCheck,
	type PortCheckStatus,
} from '@owlat/shared/networkPorts';

/** A catalog entry as the probe hands it back: the selection, plus what it found. */
interface PortCheckRow extends SelectedPortCheck {
	status: PortCheckStatus;
	durationMs: number;
}

interface PortChecksResponse {
	reachable: boolean;
	verdict?: PortChecksVerdict;
	checkedAt?: number;
	checks?: PortCheckRow[];
	error?: string;
}

const { t } = useI18n();

type CardState = 'idle' | 'running' | 'done';
const state = ref<CardState>('idle');
const result = ref<PortChecksResponse | null>(null);

const rows = computed(() => result.value?.checks ?? []);

/**
 * Inbound first, then outbound — the order an operator debugs in, and the one
 * the catalog declares. A direction with no rows is dropped rather than
 * rendered as an empty heading.
 */
const groups = computed(() =>
	(['inbound', 'outbound'] as const)
		.map((direction) => ({
			direction,
			rows: rows.value.filter((row) => row.direction === direction),
		}))
		.filter((group) => group.rows.length > 0)
);

/** Required ports that came back shut — the only rows that mean "act now". */
const failing = computed(() =>
	rows.value.filter(
		(row) => row.relevance === 'required' && (row.status === 'blocked' || row.status === 'refused')
	)
);

/**
 * The headline, from the SAME rule the sidecar applied.
 *
 * Deriving it from the blocked rows alone called an instance "all open" while a
 * port it needs went unmeasured — a required check that came back `error` or
 * `skipped` is precisely what an operator must not read as a green light. The
 * server's verdict is used when it sent one and recomputed from the rows
 * otherwise, so the two ends can only ever answer the same way.
 */
const verdict = computed<PortChecksVerdict>(
	() => result.value?.verdict ?? summarizePortChecks(rows.value)
);

/** Required rows the probe could not measure at all — what `unknown` is about. */
const unmeasured = computed(() =>
	rows.value.filter(
		(row) => row.relevance === 'required' && (row.status === 'error' || row.status === 'skipped')
	)
);

/**
 * The sidecar answered, but with a refusal of its own (a rate limit, an
 * unreadable `.env`). That is not "the updater is missing", and the CLI advice
 * on that branch would send the operator after a container that is running fine.
 */
const refusedByUpdater = computed(() => Boolean(result.value?.reachable && result.value?.error));

async function runChecks() {
	state.value = 'running';
	try {
		result.value = await apiFetch<PortChecksResponse>('/api/system/port-checks', {
			method: 'POST',
			retry: 0,
			timeout: 60_000,
		});
	} catch (err) {
		result.value = {
			reachable: false,
			error:
				err instanceof Error ? err.message : t('components.system.portChecksCard.unknownError'),
		};
	} finally {
		state.value = 'done';
	}
}

/**
 * Inbound and outbound do not mean the same thing by "open": outbound proves a
 * path all the way to a real host, inbound proves only that our own service is
 * listening — nothing running on this host can prove the internet reaches it.
 */
function statusLabel(row: PortCheckRow): string {
	if (row.status === 'open' && row.direction === 'inbound') {
		return t('components.system.portChecksCard.status.listening');
	}
	// "Nothing is listening" is only true of our own service. Outbound, a reset
	// comes from something in the path that is refusing us — a middlebox, not a
	// missing listener on a stranger's mail server.
	if (row.status === 'refused' && row.direction === 'outbound') {
		return t('components.system.portChecksCard.status.rejected');
	}
	return t(`components.system.portChecksCard.status.${row.status}`);
}

function statusTone(row: PortCheckRow): string {
	if (row.relevance === 'optional' && row.status !== 'open') return 'text-text-tertiary';
	switch (row.status) {
		case 'open':
			return 'text-success';
		case 'blocked':
			return row.relevance === 'required' ? 'text-error' : 'text-text-tertiary';
		case 'refused':
			return 'text-warning';
		default:
			return 'text-text-tertiary';
	}
}

function statusIcon(row: PortCheckRow): string {
	if (row.status === 'open') return 'lucide:check-circle-2';
	if (row.relevance === 'optional') return 'lucide:minus-circle';
	if (row.status === 'blocked') return 'lucide:shield-x';
	if (row.status === 'refused') return 'lucide:alert-triangle';
	return 'lucide:help-circle';
}
</script>

<template>
	<div class="rounded-xl border border-border-default bg-bg-elevated p-6">
		<div class="flex items-start justify-between gap-4 flex-wrap">
			<div class="min-w-0">
				<h3 class="font-semibold text-text-primary">
					{{ t('components.system.portChecksCard.title') }}
				</h3>
				<p class="mt-2 text-caption text-text-secondary max-w-2xl">
					{{ t('components.system.portChecksCard.intro') }}
				</p>
			</div>
			<UiButton
				variant="outline"
				size="sm"
				data-testid="port-checks-run"
				:disabled="state === 'running'"
				@click="runChecks"
			>
				<Icon
					v-if="state === 'running'"
					name="lucide:loader-2"
					class="w-4 h-4 animate-spin motion-reduce:animate-none"
				/>
				<Icon v-else name="lucide:network" class="w-4 h-4" />
				{{
					state === 'running'
						? t('components.system.portChecksCard.running')
						: t('components.system.portChecksCard.run')
				}}
			</UiButton>
		</div>

		<!-- Never run: say what pressing the button will do, including who it talks to. -->
		<p
			v-if="state === 'idle'"
			data-testid="port-checks-idle"
			class="mt-4 text-caption text-text-tertiary"
		>
			{{ t('components.system.portChecksCard.idle') }}
		</p>

		<!-- The sidecar answered and refused (rate limit, unreadable .env). The
		     probes did not run, but nothing is missing — so this must not carry
		     the "is the updater up?" advice below. -->
		<div
			v-else-if="state === 'done' && refusedByUpdater"
			data-testid="port-checks-declined"
			class="mt-4 rounded-lg bg-bg-surface px-3 py-2.5 text-caption text-text-secondary"
		>
			<p>{{ t('components.system.portChecksCard.declined') }}</p>
			<p class="mt-1 text-text-tertiary">{{ result?.error }}</p>
		</div>

		<!-- No updater sidecar at all: the probes cannot run on this deployment. -->
		<div
			v-else-if="state === 'done' && !result?.reachable"
			data-testid="port-checks-unreachable"
			class="mt-4 rounded-lg bg-bg-surface px-3 py-2.5 text-caption text-text-secondary"
		>
			<p>{{ t('components.system.portChecksCard.unreachable') }}</p>
			<p v-if="result?.error" class="mt-1 text-text-tertiary">{{ result.error }}</p>
		</div>

		<template v-else-if="state === 'done'">
			<!-- The verdict, then the rows. Three outcomes, three sentences: a
			     required port that is shut, a required port nobody could measure,
			     and the all-clear — which may only be said when neither of the
			     other two is true. -->
			<div
				v-if="verdict === 'degraded'"
				data-testid="port-checks-verdict"
				class="mt-4 rounded-lg border border-error/40 bg-error/5 px-3 py-2.5 text-caption text-text-secondary"
			>
				<p class="font-medium text-text-primary">
					{{ t('components.system.portChecksCard.degraded', { count: failing.length }) }}
				</p>
				<p class="mt-1">{{ t('components.system.portChecksCard.degradedHint') }}</p>
			</div>
			<div
				v-else-if="verdict === 'unknown'"
				data-testid="port-checks-verdict"
				class="mt-4 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2.5 text-caption text-text-secondary"
			>
				<p class="font-medium text-text-primary">
					{{ t('components.system.portChecksCard.unknown', { count: unmeasured.length }) }}
				</p>
				<p class="mt-1">{{ t('components.system.portChecksCard.unknownHint') }}</p>
			</div>
			<p
				v-else
				data-testid="port-checks-verdict"
				class="mt-4 text-caption text-success flex items-center gap-1.5"
			>
				<Icon name="lucide:check-circle-2" class="w-4 h-4" />
				{{ t('components.system.portChecksCard.allOpen') }}
			</p>

			<div v-for="group in groups" :key="group.direction" class="mt-5">
				<h4 class="text-xs font-medium text-text-tertiary uppercase tracking-wider">
					{{ t(`components.system.portChecksCard.groups.${group.direction}`) }}
				</h4>
				<p class="mt-1 text-xs text-text-tertiary">
					{{ t(`components.system.portChecksCard.groupHints.${group.direction}`) }}
				</p>
				<ul class="mt-2 divide-y divide-border-subtle">
					<li
						v-for="row in group.rows"
						:key="row.id"
						:data-testid="`port-check-${row.id}`"
						class="flex items-start gap-3 py-2"
					>
						<Icon
							:name="statusIcon(row)"
							class="w-4 h-4 mt-0.5 shrink-0"
							:class="statusTone(row)"
						/>
						<div class="min-w-0 flex-1">
							<p class="text-sm text-text-primary">
								<span class="font-mono">{{ row.port }}</span>
								<span class="text-text-tertiary"> · </span>
								<span>{{ row.protocol }}</span>
							</p>
							<p class="text-xs text-text-tertiary">
								{{ t(`components.system.portChecksCard.needs.${row.id}`) }}
								<template v-if="row.relevance === 'optional'">
									· {{ t('components.system.portChecksCard.notNeeded') }}
								</template>
							</p>
						</div>
						<span class="text-xs font-medium shrink-0" :class="statusTone(row)">
							{{ statusLabel(row) }}
						</span>
					</li>
				</ul>
			</div>

			<p v-if="result?.checkedAt" class="mt-4 text-xs text-text-tertiary">
				{{
					t('components.system.portChecksCard.checkedAt', {
						time: new Date(result.checkedAt).toLocaleTimeString(),
					})
				}}
			</p>
		</template>
	</div>
</template>
