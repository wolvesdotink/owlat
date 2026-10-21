import { ref, shallowRef, computed, type Ref, type ComputedRef } from 'vue';
import type { CanIEmailData, CanIEmailFeature, SupportCode } from '../types';
import { loadCanIEmailSnapshot } from './caniemailSnapshot';

/**
 * Where earlier versions cached the caniemail.com API response (~1 MB). The
 * bundled snapshot replaced that request, so the stale copy is dropped on load.
 */
const LEGACY_STORAGE_KEY = 'caniemail-data';

// Shared state across all instances
const loadedData = shallowRef<CanIEmailData | null>(null);
const isLoading = ref(false);
const error = ref<Error | null>(null);
// The snapshot load in flight, shared so concurrent callers wait for the same
// data instead of returning before it has arrived.
let inFlight: Promise<void> | null = null;

/**
 * Composable for the Can I Email support data (the snapshot bundled with the app)
 */
export function useCanIEmail(): {
	data: Ref<CanIEmailData | null>;
	isLoading: Ref<boolean>;
	error: Ref<Error | null>;
	features: ComputedRef<CanIEmailFeature[]>;
	nicenames: ComputedRef<CanIEmailData['nicenames'] | null>;
	fetchData: () => Promise<void>;
	getFeatureBySlug: (slug: string) => CanIEmailFeature | undefined;
	getFeatureSupport: (
		feature: CanIEmailFeature,
		family: string,
		platform: string | string[]
	) => SupportCode | null;
	searchFeatures: (query: string) => CanIEmailFeature[];
} {
	const data = computed(() => loadedData.value);
	const features = computed(() => data.value?.data ?? []);
	const nicenames = computed(() => data.value?.nicenames ?? null);

	/**
	 * Load the bundled snapshot once. A failed load leaves `error` set and is
	 * retried by the next call.
	 */
	async function fetchData(): Promise<void> {
		if (inFlight) return inFlight;
		if (loadedData.value) return;

		error.value = null;
		inFlight = loadSnapshot().finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	async function loadSnapshot(): Promise<void> {
		isLoading.value = true;

		try {
			loadedData.value = await loadCanIEmailSnapshot();
		} catch (e) {
			error.value = e instanceof Error ? e : new Error('Unknown error');
		} finally {
			isLoading.value = false;
		}

		try {
			localStorage.removeItem(LEGACY_STORAGE_KEY);
		} catch {
			// Ignore storage errors (no localStorage, blocked storage, etc.)
		}
	}

	/**
	 * Get a feature by its slug
	 */
	function getFeatureBySlug(slug: string): CanIEmailFeature | undefined {
		return features.value.find((f) => f.slug === slug);
	}

	/**
	 * Get support level for a specific client/platform
	 */
	function getFeatureSupport(
		feature: CanIEmailFeature,
		family: string,
		platform: string | string[]
	): SupportCode | null {
		const familyStats = feature.stats[family];
		if (!familyStats) return null;

		const platformCandidates = Array.isArray(platform) ? platform : [platform];
		let platformStats: Record<string, SupportCode | string> | null = null;
		for (const platformCandidate of platformCandidates) {
			const candidateStats = familyStats[platformCandidate];
			if (candidateStats) {
				platformStats = candidateStats;
				break;
			}
		}
		if (!platformStats) return null;

		// Get the most recent version's support
		const versions = Object.keys(platformStats).sort().reverse();
		const latestVersion = versions[0];
		if (!latestVersion) return null;

		const support = platformStats[latestVersion];
		// Handle annotations like "y #1"
		return (support?.charAt(0) as SupportCode) ?? null;
	}

	/**
	 * Search features by query
	 */
	function searchFeatures(query: string): CanIEmailFeature[] {
		const lowerQuery = query.toLowerCase();
		return features.value.filter(
			(f) =>
				f.title.toLowerCase().includes(lowerQuery) ||
				f.slug.toLowerCase().includes(lowerQuery) ||
				f.keywords.toLowerCase().includes(lowerQuery) ||
				f.description.toLowerCase().includes(lowerQuery)
		);
	}

	return {
		data,
		isLoading,
		error,
		features,
		nicenames,
		fetchData,
		getFeatureBySlug,
		getFeatureSupport,
		searchFeatures,
	};
}
