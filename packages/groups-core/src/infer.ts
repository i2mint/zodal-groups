/**
 * Profile inference — "what shape is this data *actually* in?"
 *
 * `inferProfile(space)` returns the **tightest** candidate profile (by default, the built-in ones)
 * under which the space validates, the violations of that profile (empty unless nothing fits), and
 * the evidence: the dials measured on the data, which candidates fit, and why each tighter one did
 * not. It is a migration and auditing tool (design rationale §6.3.6), and it is what a host calls
 * when it is handed edges and has to pick a profile — polytag's profile seam.
 *
 * "Tightest" is a partial order over the structural dials: profile A is at least as tight as B when
 * every cap of A is ≤ B's (`null` = unbounded) and every permission A grants, B grants too. Profiles
 * with identical dials are **equivalent** and are told apart by evidence the dials cannot see:
 * `folksonomy` over `flatTags` when every edge records `meta.assertedBy`; `thesaurus` over
 * `polyhierarchy` when an edge kind other than `contains` is in use; otherwise the earlier candidate.
 * When two fitting profiles are incomparable (a one-level, single-homed space is both a
 * `filesystem` and `flatTags`), the one whose restrictions the data visibly *exercises* most wins
 * (a cap it reaches exactly, a prohibition it has something to obey) — so one tag per item with no
 * nesting is `flatTags` — then the earlier candidate; the other is listed in `evidence.alternatives`.
 *
 * When nothing fits (a cycle from a foreign adapter, a broken family rule, an undeclared edge kind),
 * the candidate with the fewest violations is returned, with those violations — the loosest one on
 * a tie, since a failure every candidate shares says nothing about tightness.
 *
 * Cost: one full re-validation per candidate. An audit, not a hot path.
 *
 * @see `docs/research/_reconciliation.md` — D27.
 */

import type { GroupSpace, NodeId, Violation } from './model.js';
import { DEPRECATED_PROFILES, PROFILES, resolveProfile, type GroupProfile, type ProfileName } from './profile.js';
import { edgesOf, isGroup, isMembershipKind, membershipParentCount, validateProfile } from './space.js';

/** The dials measured on the data itself. */
export interface ObservedDials {
  readonly nodes: number;
  readonly edges: number;
  /** Nodes with at least one member. */
  readonly groups: number;
  /** Nodes in at least one group and with no members. */
  readonly items: number;
  /** The most groups any item is directly in (0 when no item is filed). */
  readonly maxParentsPerItem: number;
  /** The most parents any group has. */
  readonly maxParentsPerGroup: number;
  /** The deepest group-in-group nesting through transitive kinds (0 = flat). Cycle-safe. */
  readonly maxDepth: number;
  readonly groupsContainGroups: boolean;
  readonly groupsContainItems: boolean;
  /** Edge count per kind. */
  readonly edgeKinds: Readonly<Record<string, number>>;
  /** Edges whose `meta.assertedBy` is set — the folksonomy triple. */
  readonly assertedByEdges: number;
}

export interface ProfileEvidence {
  readonly observed: ObservedDials;
  /** Every candidate the space validates under, in candidate order. */
  readonly satisfied: readonly string[];
  /** Fitting candidates with the same dials as the chosen one. */
  readonly equivalent: readonly string[];
  /** Fitting candidates neither tighter nor looser than the chosen one. */
  readonly alternatives: readonly string[];
  /** Why each non-fitting candidate does not fit: its first violation's message. */
  readonly rejected: Readonly<Record<string, string>>;
}

export interface InferredProfile {
  readonly profile: GroupProfile;
  /** Violations of `profile`. Empty unless no candidate fits. */
  readonly violations: readonly Violation[];
  readonly evidence: ProfileEvidence;
}

export interface InferProfileOptions {
  /** The profiles to choose from, in preference order. Defaults to every non-deprecated built-in profile. */
  readonly candidates?: readonly (ProfileName | GroupProfile)[];
}

/** Infer the tightest profile a space satisfies. See the module docstring. */
export function inferProfile<P>(space: GroupSpace<P>, options: InferProfileOptions = {}): InferredProfile {
  const defaults = (Object.keys(PROFILES) as ProfileName[]).filter((name) => !DEPRECATED_PROFILES[name]);
  const candidates = (options.candidates ?? defaults).map((c) =>
    resolveProfile(c),
  );
  if (!candidates.length) throw new Error('inferProfile: `candidates` is empty.');

  const observed = observeDials(space);
  const results = candidates.map((profile) => ({ profile, violations: validateProfile(space, profile) }));
  const fitting = results.filter((r) => r.violations.length === 0).map((r) => r.profile);
  const rejected: Record<string, string> = {};
  for (const r of results) if (r.violations.length) rejected[r.profile.name] = r.violations[0]!.message;

  if (!fitting.length) {
    // Fewest violations; on a tie, the LOOSEST — when every candidate fails the same way (a cycle,
    // a family rule), the failure says nothing about tightness, and a tight profile would add noise.
    const fewest = Math.min(...results.map((r) => r.violations.length));
    const tied = results.filter((r) => r.violations.length === fewest);
    const closest = tied.find((a) => !tied.some((b) => strictlyTighter(a.profile, b.profile))) ?? tied[0]!;
    return {
      profile: closest.profile,
      violations: closest.violations,
      evidence: { observed, satisfied: [], equivalent: [], alternatives: [], rejected },
    };
  }

  // The minimal elements of the "at least as tight" partial order. Among incomparable ones, the data
  // decides: the profile whose restrictions it visibly exercises most; then candidate order.
  const minimal = fitting.filter((a) => !fitting.some((b) => strictlyTighter(b, a)));
  const first = minimal.reduce((best, p) => (exercised(p, observed) > exercised(best, observed) ? p : best));
  const equivalents = fitting.filter((p) => sameDials(p, first));
  const chosen = preferByEvidence(equivalents, observed) ?? first;

  return {
    profile: chosen,
    violations: [],
    evidence: {
      observed,
      satisfied: fitting.map((p) => p.name),
      equivalent: equivalents.filter((p) => p !== chosen).map((p) => p.name),
      alternatives: minimal.filter((p) => !sameDials(p, first)).map((p) => p.name),
      rejected,
    },
  };
}

// ── the partial order ───────────────────────────────────────────────────────

type Cap = number | null;
const capLe = (a: Cap, b: Cap): boolean => (b === null ? true : a !== null && a <= b);
const permLe = (a: boolean, b: boolean): boolean => !a || b; // a grants ⇒ b grants

/** Every cap of `a` is ≤ `b`'s, and everything `a` permits `b` permits. */
function atLeastAsTight(a: GroupProfile, b: GroupProfile): boolean {
  return (
    capLe(a.maxParentsPerItem, b.maxParentsPerItem) &&
    capLe(a.maxParentsPerGroup, b.maxParentsPerGroup) &&
    capLe(a.maxDepth, b.maxDepth) &&
    capLe(a.maxGroupsPerItem, b.maxGroupsPerItem) &&
    permLe(a.groupsMayContainGroups, b.groupsMayContainGroups) &&
    permLe(a.groupsMayContainItems, b.groupsMayContainItems) &&
    Object.keys(a.edgeKinds).every((k) => k in b.edgeKinds)
  );
}

const sameDials = (a: GroupProfile, b: GroupProfile): boolean => atLeastAsTight(a, b) && atLeastAsTight(b, a);
const strictlyTighter = (a: GroupProfile, b: GroupProfile): boolean => atLeastAsTight(a, b) && !atLeastAsTight(b, a);

/**
 * How many of a profile's restrictions the data visibly exercises: a cap the data reaches exactly,
 * or a prohibition the data has something to obey. One tag per item with no nesting exercises
 * `flatTags` twice (depth 0, no nesting) and `filesystem` once (one parent per item).
 */
function exercised(p: GroupProfile, o: ObservedDials): number {
  const reached = (cap: Cap, value: number, applicable: boolean) => (cap !== null && applicable && value === cap ? 1 : 0);
  return (
    reached(p.maxParentsPerItem, o.maxParentsPerItem, o.items > 0) +
    reached(p.maxGroupsPerItem, o.maxParentsPerItem, o.items > 0) +
    reached(p.maxParentsPerGroup, o.maxParentsPerGroup, o.groups > 0 && o.maxParentsPerGroup > 0) +
    reached(p.maxDepth, o.maxDepth, o.groups > 0) +
    (!p.groupsMayContainGroups && o.groups > 0 ? 1 : 0) +
    (!p.groupsMayContainItems && o.groups > 0 ? 1 : 0)
  );
}

/** Tell equivalent profiles apart by what their names promise beyond the dials. */
function preferByEvidence(equivalents: readonly GroupProfile[], o: ObservedDials): GroupProfile | undefined {
  const named = (name: string) => equivalents.find((p) => p.name === name);
  if (o.edges > 0 && o.assertedByEdges === o.edges && named('folksonomy')) return named('folksonomy');
  const typedKinds = Object.keys(o.edgeKinds).some((k) => k !== 'contains');
  if (typedKinds && named('thesaurus')) return named('thesaurus');
  return undefined;
}

// ── measuring ───────────────────────────────────────────────────────────────

/** Measure the dials a space actually exhibits. Cycle-safe. */
export function observeDials<P>(space: GroupSpace<P>): ObservedDials {
  let groups = 0;
  let items = 0;
  let maxParentsPerItem = 0;
  let maxParentsPerGroup = 0;
  for (const id of space.nodes.keys()) {
    const parents = membershipParentCount(space, id);
    if (isGroup(space, id)) {
      groups += 1;
      maxParentsPerGroup = Math.max(maxParentsPerGroup, parents);
    } else if (parents > 0) {
      items += 1;
      maxParentsPerItem = Math.max(maxParentsPerItem, parents);
    }
  }

  const edgeKinds: Record<string, number> = {};
  let assertedByEdges = 0;
  let groupsContainGroups = false;
  let groupsContainItems = false;
  for (const edge of space.edges.values()) {
    edgeKinds[edge.kind] = (edgeKinds[edge.kind] ?? 0) + 1;
    if (edge.meta?.assertedBy !== undefined) assertedByEdges += 1;
    if (!isMembershipKind(space.profile, edge.kind)) continue;
    if (isGroup(space, edge.child)) groupsContainGroups = true;
    else groupsContainItems = true;
  }

  // Longest group-in-group chain below each node, memoized; a node on the current path counts 0
  // (cycle guard), so this terminates on data the write path never saw.
  const memo = new Map<NodeId, number>();
  const onPath = new Set<NodeId>();
  const depthBelow = (node: NodeId): number => {
    const known = memo.get(node);
    if (known !== undefined) return known;
    if (onPath.has(node)) return 0;
    onPath.add(node);
    let deepest = 0;
    for (const edge of edgesOf(space, node)) {
      if (!space.profile.edgeKinds[edge.kind]?.transitive) continue;
      if (!isGroup(space, edge.child)) continue;
      deepest = Math.max(deepest, 1 + depthBelow(edge.child));
    }
    onPath.delete(node);
    memo.set(node, deepest);
    return deepest;
  };
  let maxDepth = 0;
  for (const id of space.nodes.keys()) maxDepth = Math.max(maxDepth, depthBelow(id));

  return {
    nodes: space.nodes.size,
    edges: space.edges.size,
    groups,
    items,
    maxParentsPerItem,
    maxParentsPerGroup,
    maxDepth,
    groupsContainGroups,
    groupsContainItems,
    edgeKinds,
    assertedByEdges,
  };
}
