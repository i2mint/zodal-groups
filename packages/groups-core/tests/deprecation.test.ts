/**
 * `taxonomy` is deprecated (issue #4, item 4): it cannot hold any space with at least one edge
 * (a leaf is childless, so it is an item), and a vocabulary is better modelled as a separate space.
 */

import { describe, expect, it, vi } from 'vitest';
import { createGroupSpace, DEPRECATED_PROFILES, inferProfile, resolveProfile } from '../src/index.js';

describe('the taxonomy profile is deprecated', () => {
  it('warns once, with the replacement, and still resolves (no silent change of meaning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(resolveProfile('taxonomy').groupsMayContainItems).toBe(false);
      resolveProfile('taxonomy');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/taxonomy.*deprecated.*separate space/s);
    } finally {
      warn.mockRestore();
    }
  });

  it('is listed with its reason, and never inferred by default', () => {
    expect(Object.keys(DEPRECATED_PROFILES)).toEqual(['taxonomy']);
    expect(inferProfile(createGroupSpace()).evidence.satisfied).not.toContain('taxonomy');
  });
});
