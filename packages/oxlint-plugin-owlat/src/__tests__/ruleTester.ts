/**
 * oxlint's own RuleTester, driven by vitest. It parses each case with the same
 * native parser oxlint lints with and runs the rule in-process, so a rule's
 * unit tests need no oxlint subprocess (the integration suite covers loading
 * the plugin through the real config).
 */
import { RuleTester } from 'oxlint/plugins-dev';
import { describe, it } from 'vitest';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

export const ruleTester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } });
