/**
 * The DNS records the desktop setup wizard asks the operator to create for
 * the chosen domain, with the starter SPF record folded into one the host
 * already publishes.
 */
import type { Ref } from 'vue';
import type { InstanceHostnames } from '~/lib/desktop/provisioning';
import {
	resolveServerIp,
	buildDnsRecords,
	type DnsRecordRow,
} from '~/lib/desktop/provisioningForm';
import { computeSpfSuggestion, type SpfCoexistenceSuggestion } from '~/utils/spfCoexistence';

export function useSetupDnsRecords(options: {
	/** The SSH address the wizard connected to. */
	host: Readonly<Ref<string>>;
	/** The public IP the operator entered (or the one detected over SSH). */
	publicIp: Readonly<Ref<string>>;
	effectiveHosts: Readonly<Ref<InstanceHostnames | null>>;
	usesOwnMta: Readonly<Ref<boolean>>;
}) {
	const { host, publicIp, effectiveHosts, usesOwnMta } = options;

	/**
	 * The A-record target: the SSH address itself when it is an IP, else the public
	 * IP the user supplied below, else null (the table flags a placeholder and
	 * disables its copy button rather than handing over an un-pasteable string).
	 */
	const serverIp = computed(() => resolveServerIp(host.value, publicIp.value));
	/** True when the SSH address is itself an IP (so no separate public-IP prompt is needed). */
	const hostIsIp = computed(() => resolveServerIp(host.value, '') !== null);

	/**
	 * DNS records implied by the chosen public domain (+ MTA hostnames), shown
	 * live in the form and again on the success screen. For an MTA install this
	 * also surfaces starter SPF + DMARC records so the user does not assume the
	 * A/MX records alone make mail deliverable.
	 */
	const dnsRecords = computed(() => {
		const hosts = effectiveHosts.value;
		if (!hosts) return [];
		return buildDnsRecords({
			hosts,
			withMta: usesOwnMta.value,
			serverIp: serverIp.value,
		});
	});

	/**
	 * SPF coexistence: if the host where we'd publish the starter SPF record
	 * already carries a foreign SPF record, publishing a second `v=spf1` is a
	 * PermError (RFC 7208 §3.2). Resolve it (DoH) and, when a collision is found,
	 * fold our mechanisms into the existing record. Fail-soft — no suggestion
	 * leaves the starter value untouched.
	 */
	const isStarterSpf = (r: DnsRecordRow) => r.type === 'TXT' && r.value.startsWith('v=spf1');

	/**
	 * The only inputs the DoH lookup depends on — the SPF row's publish host + its
	 * value — as a scalar key, so the watcher fires when those change rather than
	 * on every `dnsRecords` recompute (packs/IP edits etc.).
	 */
	const spfLookupKey = computed(() => {
		const row = dnsRecords.value.find(isStarterSpf);
		return row ? `${row.name}\u0000${row.value}` : '';
	});

	/**
	 * A host complete enough to resolve: a dotted name with non-empty labels and a
	 * ≥2-char alphabetic final label. Guards against firing DoH lookups against the
	 * partial hostnames produced on every keystroke in the domain field.
	 */
	function looksResolvable(host: string): boolean {
		const labels = host.trim().split('.');
		if (labels.length < 2 || labels.some((label) => label === '')) return false;
		return /^[a-z]{2,}$/i.test(labels[labels.length - 1] ?? '');
	}

	const spfCoexistence = ref<SpfCoexistenceSuggestion | null>(null);
	let spfLookupTimer: ReturnType<typeof setTimeout> | null = null;
	watch(
		spfLookupKey,
		() => {
			spfCoexistence.value = null;
			if (spfLookupTimer) clearTimeout(spfLookupTimer);
			const row = dnsRecords.value.find(isStarterSpf);
			if (!row || !looksResolvable(row.name)) return;
			const { name, value } = row;
			// Debounce so typing in the domain field doesn't fire a DoH request per keystroke.
			spfLookupTimer = setTimeout(() => {
				void computeSpfSuggestion(name, value).then((result) => {
					// Ignore a slow DoH response if the SPF row changed meanwhile.
					const current = dnsRecords.value.find(isStarterSpf);
					if (result && current && current.name === name && current.value === value) {
						spfCoexistence.value = result;
					}
				});
			}, 450);
		},
		{ immediate: true }
	);

	/** DNS rows for display, with the starter SPF row merged into any existing one. */
	const displayDnsRecords = computed<DnsRecordRow[]>(() => {
		const suggestion = spfCoexistence.value;
		if (!suggestion) return dnsRecords.value;
		return dnsRecords.value.map((r) =>
			isStarterSpf(r)
				? {
						...r,
						value: suggestion.merged,
						note: 'desktop.setup.dns.spfMergedNote',
					}
				: r
		);
	});

	onBeforeUnmount(() => {
		if (spfLookupTimer) clearTimeout(spfLookupTimer);
	});

	return { serverIp, hostIsIp, dnsRecords, displayDnsRecords };
}
