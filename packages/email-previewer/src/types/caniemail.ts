/**
 * Types for the caniemail.com API data structure
 */

export type SupportCode = 'y' | 'n' | 'a' | 'u';

export interface CanIEmailNicenames {
	family: Record<string, string>;
	platform: Record<string, string>;
	support: Record<string, string>;
	category: Record<string, string>;
}

export interface FeatureStats {
	[clientFamily: string]: {
		[platform: string]: {
			[version: string]: SupportCode | string; // Can have annotations like "y #1"
		};
	};
}

export interface CanIEmailFeature {
	slug: string;
	title: string;
	description: string;
	url: string;
	category: 'css' | 'html' | 'image' | 'others';
	keywords: string;
	last_test_date: string;
	test_url: string;
	test_results_url: string;
	notes: string;
	notes_by_num: Record<string, string>;
	stats: FeatureStats;
}

export interface CanIEmailData {
	api_version: string;
	last_update_date: string;
	nicenames: CanIEmailNicenames;
	data: CanIEmailFeature[];
}

export interface FeatureSupportResult {
	feature: CanIEmailFeature;
	support: SupportCode;
	note?: string;
}
