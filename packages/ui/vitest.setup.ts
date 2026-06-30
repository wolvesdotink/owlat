/**
 * Nuxt-layer auto-import polyfills for vitest (mirrors apps/web's setup —
 * see CLAUDE.md: never run these with `bun test`, it skips this file).
 */
import { vi } from 'vitest';
import { ref, computed, reactive, readonly, watch, watchEffect, onMounted, onUnmounted, onBeforeUnmount, nextTick, shallowRef, unref, isRef } from 'vue';

vi.stubGlobal('ref', ref);
vi.stubGlobal('computed', computed);
vi.stubGlobal('reactive', reactive);
vi.stubGlobal('readonly', readonly);
vi.stubGlobal('watch', watch);
vi.stubGlobal('watchEffect', watchEffect);
vi.stubGlobal('onMounted', onMounted);
vi.stubGlobal('onUnmounted', onUnmounted);
vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);
vi.stubGlobal('nextTick', nextTick);
vi.stubGlobal('shallowRef', shallowRef);
vi.stubGlobal('unref', unref);
vi.stubGlobal('isRef', isRef);
