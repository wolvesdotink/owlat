/**
 * The interface languages the product ships. Keep the validator in lockstep
 * with the list: the classifier writes one summary per entry, and the
 * clarification loop translates its questions into every entry but English.
 * Re-exported from lib/convexValidators.ts so existing imports resolve.
 */

import { v } from 'convex/values';

export const APP_LOCALES = ['en', 'de'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export const appLocaleValidator = v.union(v.literal('en'), v.literal('de'));
