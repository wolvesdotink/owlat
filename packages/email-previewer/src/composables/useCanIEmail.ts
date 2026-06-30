import { ref, shallowRef, computed, type Ref, type ComputedRef } from 'vue';
import type { CanIEmailData, CanIEmailFeature, SupportCode } from '../types';

const CANIEMAIL_API_URL = 'https://www.caniemail.com/api/data.json';
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

interface CachedData {
	data: CanIEmailData;
	timestamp: number;
}

// Shared state across all instances
const cachedData = shallowRef<CachedData | null>(null);
const isLoading = ref(false);
const error = ref<Error | null>(null);

/**
 * Composable for fetching and managing caniemail.com data
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
	const data = computed(() => cachedData.value?.data ?? null);
	const features = computed(() => data.value?.data ?? []);
	const nicenames = computed(() => data.value?.nicenames ?? null);

	/**
	 * Fetch data from caniemail.com API with caching
	 */
	async function fetchData(): Promise<void> {
		error.value = null;

		// Check cache validity
		if (cachedData.value && Date.now() - cachedData.value.timestamp < CACHE_DURATION) {
			return;
		}

		// Check localStorage cache
		try {
			const stored = localStorage.getItem('caniemail-data');
			if (stored) {
				const parsed: CachedData = JSON.parse(stored);
				if (Date.now() - parsed.timestamp < CACHE_DURATION) {
					cachedData.value = parsed;
					return;
				}
			}
		} catch {
			// Ignore localStorage errors
		}

		if (isLoading.value) return;

		isLoading.value = true;

		try {
			const response = await fetch(CANIEMAIL_API_URL);
			if (!response.ok) {
				throw new Error(`Failed to fetch: ${response.statusText}`);
			}

			const apiData: CanIEmailData = await response.json();

			const cached: CachedData = {
				data: apiData,
				timestamp: Date.now(),
			};

			cachedData.value = cached;

			// Store in localStorage
			try {
				localStorage.setItem('caniemail-data', JSON.stringify(cached));
			} catch {
				// Ignore storage errors (quota exceeded, etc.)
			}
		} catch (e) {
			error.value = e instanceof Error ? e : new Error('Unknown error');
		} finally {
			isLoading.value = false;
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
