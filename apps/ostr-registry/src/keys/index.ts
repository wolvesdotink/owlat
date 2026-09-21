/**
 * Key discovery: the {@link KeyDirectory} implementations the composition root
 * wires into the log (plan §5, §4.2).
 *
 * Three of them, in one shape: DNS discovery for production, a fixed map for
 * tests and pinned deployments, and the bootstrap allowlist that wraps either.
 * The log knows only the interface, so which one is running is a configuration
 * decision — and the allowlist can be turned off without touching a code path.
 */
export {
	AllowlistKeyDirectory,
	parseBootstrapObservers,
	type BootstrapObserver,
} from './bootstrap.js';
export {
	DEFAULT_KEY_TTL_MS,
	DEFAULT_MAX_CACHED_DOMAINS,
	DEFAULT_MAX_CONCURRENT_LOOKUPS,
	DEFAULT_NEGATIVE_TTL_MS,
	DnsKeyDirectory,
	KeyLookupOverloadError,
	type DnsKeyDirectoryOptions,
	type ResolveTxt,
} from './dns.js';
export {
	normalizeObserverDomain,
	StaticKeyDirectory,
	toKeyRecord,
	type StaticKeyEntries,
} from './static.js';
