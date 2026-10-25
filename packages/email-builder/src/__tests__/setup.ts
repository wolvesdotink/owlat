/**
 * Vitest setup for every email-builder suite.
 *
 * Every wrapper `mount` / `shallowMount` returns is unmounted after its test,
 * also when an assertion or a wait in it failed, so no component, listener or
 * teleported node outlives the test that made it, and no suite clears the
 * document to clean up. This is the package's only registration:
 * @vue/test-utils throws if a test file registers a second one. Nodes a test
 * appends to the body itself, and plain `createApp` mounts, stay the test's to
 * remove.
 *
 * The default environment is node; nothing here touches the DOM until a hook
 * runs, so node suites load it unchanged.
 */
import { afterEach } from 'vitest';
import { enableAutoUnmountOnce } from '@owlat/ui/__tests__/autoUnmount';

enableAutoUnmountOnce(afterEach);
