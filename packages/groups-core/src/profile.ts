/**
 * Constraint profiles — one model, named restrictions, each buying a guarantee.
 *
 * This is the module that makes the pitch true: a filesystem and a tag cloud are the *same object*
 * with a different `maxParentsPerItem`. Rather than shipping four data models (folders, tags,
 * categories, facets), we ship one and parameterize the restrictions.
 *
 * The framing ("a profile is a set of restrictions that buys you a guarantee") is borrowed from
 * OWL 2 Profiles; the validation-report shape is borrowed from SHACL, whose `sh:maxCount` on a
 * `broader` path is literally our `maxParentsPerGroup`; and the profile *ladder* (list → synonym
 * ring → taxonomy → thesaurus) is Z39.19's, from 2005. We did not invent this ladder — we typed it.
 *
 * The profile is a **runtime validator first**. Type-level narrowing is a bonus applied on top
 * (see `facade.ts`), never the foundation: edges arrive from store adapters and imports that never
 * heard of our profile, so the validator has to exist regardless.
 *
 * @see `docs/research/_reconciliation.md` — decision D14, §3.
 */

import { DEFAULT_EDGE_KINDS, type EdgeKindDef } from './model.js';

/**
 * The restrictions. Every field is a dial; the named profiles below are just presets.
 *
 * Note there is no `allowCycles`. Cycles are never permitted on write — they break closure,
 * refcounting, and termination. (Projections are nevertheless cycle-*safe* on read, because we
 * don't own our data. That is a separate concern; see `projections/tree.ts`.)
 */
export interface GroupProfile {
  readonly name: string;

  // ── structural ────────────────────────────────────────────────────────────
  /** How many groups may an *item* (a childless node) be in? `1` ⇒ classic folders. */
  readonly maxParentsPerItem: number | null;
  /** How many parents may a *group* have? `1` ⇒ the group graph is a forest (cheap breadcrumbs). */
  readonly maxParentsPerGroup: number | null;
  /** Nesting depth of the group graph. `0` ⇒ flat tagging (no tagging of tags). */
  readonly maxDepth: number | null;
  /** Cap on an item's total memberships, when you want a dial separate from `maxParentsPerItem`. */
  readonly maxGroupsPerItem: number | null;
  /** May a group contain another group? `false` ⇒ a flat tag namespace. */
  readonly groupsMayContainGroups: boolean;
  /** May a group contain a non-group item? `false` ⇒ a pure classification skeleton. */
  readonly groupsMayContainItems: boolean;
  /** May a group be a *member* (i.e. treated as an item)? `true` ⇒ Are.na's channel-as-block. */
  readonly groupsAreItems: boolean;
  /** Is order within a group meaningful? */
  readonly ordered: boolean;

  // ── semantic ──────────────────────────────────────────────────────────────
  /** Per-kind closure semantics. The part most libraries forget. */
  readonly edgeKinds: Readonly<Record<string, EdgeKindDef>>;
}

const BASE: Omit<GroupProfile, 'name'> = {
  maxParentsPerItem: null,
  maxParentsPerGroup: null,
  maxDepth: null,
  maxGroupsPerItem: null,
  groupsMayContainGroups: true,
  groupsMayContainItems: true,
  groupsAreItems: false,
  ordered: false,
  edgeKinds: DEFAULT_EDGE_KINDS,
};

/**
 * The named profiles. Each row of this table is a use case the user asked us to cover
 * "seamlessly" — and each is the same model with different dials.
 */
export const PROFILES = {
  /** Folders and subfolders. An item lives in exactly one place; so does a folder. */
  filesystem: {
    ...BASE,
    name: 'filesystem',
    maxParentsPerItem: 1,
    maxParentsPerGroup: 1,
    ordered: true,
  },

  /** Flat tags. Many tags per item, but no tagging of tags. */
  flatTags: {
    ...BASE,
    name: 'flatTags',
    maxDepth: 0,
    groupsMayContainGroups: false,
  },

  /**
   * Nested tags — Obsidian/Bear `#parent/child` semantics, but with *real edges* rather than a
   * string with slashes in it. (In the string-based systems polyhierarchy is unrepresentable,
   * renaming is O(items), and there is nowhere to hang edge metadata.)
   */
  nestedTags: {
    ...BASE,
    name: 'nestedTags',
    maxParentsPerGroup: 1,
  },

  /** Gmail: a message carries many labels; the label tree itself is a tree. */
  labels: {
    ...BASE,
    name: 'labels',
    maxParentsPerItem: null,
    maxParentsPerGroup: 1,
  },

  /** The general case: an item or a group may have several parents. Acyclic. */
  polyhierarchy: {
    ...BASE,
    name: 'polyhierarchy',
  },

  /** A classification skeleton: groups of groups only; items never attach. */
  taxonomy: {
    ...BASE,
    name: 'taxonomy',
    groupsMayContainItems: false,
  },

  /** Z39.19 / SKOS: polyhierarchy plus typed, semantically-distinct edge kinds. */
  thesaurus: {
    ...BASE,
    name: 'thesaurus',
    edgeKinds: DEFAULT_EDGE_KINDS,
  },

  /** Flat tags, but membership edges are per-user — the `(tag, object, identity)` triple. */
  folksonomy: {
    ...BASE,
    name: 'folksonomy',
    maxDepth: 0,
    groupsMayContainGroups: false,
  },
} as const satisfies Record<string, GroupProfile>;

/** The name of a built-in profile. */
export type ProfileName = keyof typeof PROFILES;

/**
 * Resolve a profile from a name, a full profile, or a name plus overrides.
 *
 * Progressive disclosure: `defineGroups({ profile: 'filesystem' })` is the simple path;
 * `{ profile: 'polyhierarchy', maxDepth: 3 }` is the hybrid the user asked for.
 */
export function resolveProfile(
  profile: ProfileName | GroupProfile = 'polyhierarchy',
  overrides: Partial<Omit<GroupProfile, 'name'>> = {},
): GroupProfile {
  const base: GroupProfile = typeof profile === 'string' ? PROFILES[profile] : profile;
  return { ...base, ...overrides };
}

/** True when the profile forbids any nesting at all — the flat-tagging case. */
export const isFlat = (p: GroupProfile): boolean =>
  p.maxDepth === 0 || !p.groupsMayContainGroups;

/** True when the group graph is guaranteed to be a forest, so every group has at most one path. */
export const isGroupTree = (p: GroupProfile): boolean => p.maxParentsPerGroup === 1;

/** True when an item can only ever be in one place — the classic folder guarantee. */
export const isSingleHomed = (p: GroupProfile): boolean => p.maxParentsPerItem === 1;
