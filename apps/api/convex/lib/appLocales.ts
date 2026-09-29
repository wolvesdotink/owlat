/**
 * The interface languages the product ships, as the Convex side sees them. The
 * list itself lives in `@owlat/shared/appLocales`; the validator is derived
 * from it, so a new locale is accepted on profile writes the moment it ships.
 * The classifier writes one summary per entry, and the clarification loop
 * translates its questions into every entry but English.
 * Re-exported from lib/convexValidators.ts so existing imports resolve.
 */

import { APP_LOCALES } from '@owlat/shared/appLocales';
import { literalUnion } from './literalUnion';

export { APP_LOCALES, type AppLocale } from '@owlat/shared/appLocales';
export const appLocaleValidator = literalUnion(APP_LOCALES);
