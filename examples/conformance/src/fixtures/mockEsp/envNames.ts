/**
 * MOCK ESP — the bundle's ENVIRONMENT VARIABLE NAMES, declared once.
 *
 * A bundle spells each of these in at least two places: the MANIFEST declares it
 * (so the host knows to resolve it, and so a credential form can write to it) and
 * the MODULE reads it out of the instance configuration it is handed. A string
 * literal on the module's side is the "one declaration, many derivations" shape
 * this whole plan exists to remove — rename the manifest's constant and the
 * module goes on reading a key the host will never populate, which surfaces as an
 * authentication failure rather than as a rename that did not compile.
 *
 * This module is therefore the single declaration, and it is the one thing in the
 * bundle that BOTH halves may import: no `@owlat/plugin-kit` import, no Node
 * builtin, nothing with a runtime — so the isolate-safe halves (`webhook.ts`,
 * `domainIdentity.ts`) can read it without dragging anything into the HTTP
 * router's module graph.
 *
 * A real third-party bundle would do exactly this, which is the other reason it
 * is here: this fixture is the reference an author copies.
 */

/** The transport's own credential — resolved per instance and handed to `send`. */
export const MOCK_ESP_TOKEN_ENV = 'PLUGIN_MOCK_ESP_TOKEN';

/** An optional refinement, so the fixture exercises a non-required descriptor. */
export const MOCK_ESP_REGION_ENV = 'PLUGIN_MOCK_ESP_REGION';

/** The host-verified webhook signing secret. Never seen by plugin code. */
export const MOCK_ESP_WEBHOOK_SECRET_ENV = 'PLUGIN_MOCK_ESP_WEBHOOK_SECRET';

/** The plugin's deployment-wide enablement switch, distinct from the credential. */
export const MOCK_ESP_ENABLED_ENV = 'MOCK_ESP_ENABLED';
