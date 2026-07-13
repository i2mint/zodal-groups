# zodal-groups Research 01 — Classification Theory, Polyhierarchy, and Tag-System Semantics

**Scope**: standard vocabulary, polyhierarchy standards & production systems, the invariants a polyhierarchy must maintain, hierarchical tagging in real tools, set-theoretic/algebraic framing, and prior art for constraint profiles.

**Conventions in this document**
- **HARD FACT** = cited to a primary or near-primary source, numbered `[n]`.
- **[SYNTHESIS]** = my analysis / recommendation, *not* attributable to a source.
- **OPEN DECISION** = a design fork we must resolve, with options + recommendation.

---

## 0. Executive summary — the thesis, tested

> **Working thesis under test**: *membership is the canonical data (a flat set of item→group and group→group edges); every tree, tag cloud, or facet browser is a computed projection over those edges. The "only in one place" limit was never in the data — it is a property of one projection.*

**Verdict: substantially CONFIRMED, with three refinements that change the design.**

**Confirmation 1 — the strongest possible evidence comes from the very system the thesis claims to generalize.** POSIX filesystems do *not* enforce "an item lives in exactly one place." A regular file may be hard-linked into arbitrarily many directories (`nlink > 1`); what is forbidden is hard links *to directories*, precisely so the directory graph stays acyclic and reference-counting can reclaim space [37]. So the real Unix rule is not "one parent" — it is a **constraint profile**:

| entity | max parents | why |
|---|---|---|
| file (item) | ∞ | nothing breaks |
| directory (group) | **1** | cycle prevention + refcount GC [37] |

The folk belief that "files live in one folder" is an artifact of the *path projection* (and of GUI file managers that only ever show one path). This is exactly the thesis, empirically, in the canonical case.

**Confirmation 2 — every production polyhierarchy already stores edges and projects.** MeSH stores descriptors and gives them *multiple tree numbers* — the "tree" is a derived addressing scheme, and a descriptor "may appear in as many additional locations as appropriate" [4,5]. Are.na stores *connections* and a block may be connected to unboundedly many channels [19,20]. Zotero stores collection membership; adding an item to a second collection "does not duplicate the item" [15]. SKOS *permits* multiple `skos:broader` and explicitly labels the poly-hierarchical example "consistent" [1].

**Refinement A (important) — membership edges alone are NOT sufficient. You need the edge's *kind*.**
Z39.19 distinguishes three hierarchical relation types — generic (BTG), instance (BTI), whole-part (BTP) — and mandates the **"all-and-some" test** before you may assert BT/NT at all [3, §8.3]. SKOS deliberately makes `skos:broader` **non-transitive**, precisely because a chain that mixes relation kinds (wheel *part-of* car, car *is-a* vehicle) yields false inferences [1,2]. GO gets to keep transitivity only because it declares relation composition rules (`is_a ∘ part_of → part_of`) [6]. **Consequence for us: "is an item tagged `poodle` also in `animal`?" is not answerable from the edge set alone — it is answerable from the edge set *plus the closure semantics declared for that edge kind*.** This is the single most load-bearing finding in this report.

**Refinement B — in some systems the *path is the identifier*.** A filesystem path, a URL, and a Gmail label name (`Parent/Child` is literally one string [21,22]) are keys. Once membership is canonical and multi-parent, **paths stop being identifiers** and become *routes*. Breadcrumbs, deep links, and "where am I" all break unless you either (a) designate a canonical/primary parent, or (b) make routes first-class. NN/g reports exactly this as polyhierarchy's chief practical cost: sites must still show a single "canonical" breadcrumb path even when the item has many parents [10].

**Refinement C — "group" is overloaded.** SKOS found it necessary to have *two* grouping constructs: `skos:Concept` (participates in `broader`/`narrower`) and `skos:Collection` (a grouping device — arrays, node labels, facet indicators) which is **disjoint from Concept and must NOT be used with `skos:broader`** [1 §S37, 2]. Z39.19 calls the same thing a **node label** / facet indicator: a "dummy term … not assigned to documents when indexing … inserted to indicate the logical basis on which a class has been divided" [3, glossary + §8.3.5]. We will need this distinction (see §7, `role: 'grouper' | 'classifier'`).

---

## 1. Vocabulary — what the terms actually mean

These are the words practitioners will use at us. Getting them right is half the design.

| term | precise meaning | source |
|---|---|---|
| **controlled vocabulary** | "A list of terms that have been enumerated explicitly … All terms … must have an unambiguous, non-redundant definition." The umbrella term. | [3, glossary] |
| **list / pick list** | Flat set of terms, **no relationships of any kind**. | [3, §5.4.1] |
| **synonym ring** | Set of terms treated as equivalent *for retrieval only*; cannot be used for indexing. (≈ tag aliases.) | [3, §5.4.2] |
| **taxonomy** | "A controlled vocabulary consisting of preferred terms, all of which are connected in a **hierarchy or polyhierarchy**." Note: Z39.19's own definition admits polyhierarchy. | [3, §5.4.3] |
| **thesaurus** | Controlled vocabulary with *standardized, reciprocal relationship indicators*: BT/NT (hierarchical), RT (associative), USE/UF (equivalence). | [3, §5.4.4, §8] |
| **ontology** | Formal, machine-interpretable model with classes, properties, axioms and entailment (OWL). Strictly more expressive than a thesaurus. | [28] |
| **facet** | "A grouping of concepts of the **same inherent category**" — e.g. activities, disciplines, people, materials, places. A facet is an **axis**, not a node. | [3, glossary] |
| **node label / facet indicator** | A "dummy term … not assigned to documents when indexing" inserted into a hierarchy "to indicate the **logical basis on which a class has been divided**" (e.g. `<cars by motive power>`). Not a term. Z39.19 explicitly aliases *facet indicator → node label*. | [3, glossary + §8.3.5] |
| **folksonomy** | Vander Wal: "the result of **personal free tagging** of information and objects … for **one's own retrieval**." Its unit is a **triple: (tag, object, identity)** — the *identity* is constitutive, not incidental. Not a taxonomy; no parent/child. | [12] |
| **broad vs narrow folksonomy** | *Broad*: many users tag the same object (del.icio.us). *Narrow*: few/one user tags objects they own (Flickr). | [12] |
| **enumerative classification** | All subjects pre-listed with pre-assigned notation (DDC, LCC). "A register of subjects and their class numbers." | [search synthesis of LIS sources; see §2] |
| **analytico-synthetic / faceted classification** | Subjects are *analyzed* into facets, then class numbers *synthesized* by combining facet values in a prescribed **citation order**. "A machine to design class numbers." | [§2] |
| **PMEST** | Ranganathan's five fundamental categories: **P**ersonality, **M**atter, **E**nergy, **S**pace, **T**ime — the canonical citation order of Colon Classification. | [§2] |
| **monohierarchy** | Every node has ≤ 1 parent (a forest/tree). | [3, by contrast with below] |
| **polyhierarchy** | "A controlled vocabulary structure in which **some terms belong to more than one hierarchy**. For example, *rose* might be a narrower term under both *flowers* and *perennials*." | [3, glossary] |
| **all-and-some test** | The gate for asserting BT/NT: **all** members of the narrower class must be members of the broader class, and only **some** members of the broader class are members of the narrower. If it fails, use RT, not BT. | [3, §8.3.1] |
| **citation order** | The fixed sequence in which facets are combined (PMEST). Determines what the *primary* browse hierarchy looks like. | [§2] |

**Common practitioner misuse** [SYNTHESIS, grounded in the definitions above]:
1. **"Taxonomy" used to mean "tree."** Z39.19's own definition allows polyhierarchy [3, §5.4.3]. So "we need a taxonomy" does *not* mean "we need a tree."
2. **"Facet" used to mean "filter chip" or "any tag group."** A facet is a set of *mutually exclusive-ish values drawn from one inherent category*. `color`, `size`, `material` are facets. `#todo`, `#interesting` are not.
3. **"Ontology" used to mean "a hierarchy with some extra fields."** No entailment ⇒ not an ontology.
4. **"Folksonomy" used to mean "user-editable tags."** Vander Wal's point is that folksonomy is the *aggregate* of (tag, object, user) triples; drop the user and you've got tagging, not folksonomy [12].
5. **Node labels indexed as terms.** Z39.19 forbids this [3]; SKOS enforces it structurally by making `Collection` disjoint from `Concept` [1, §S37].

---

## 2. Faceted classification

**Ranganathan / Colon Classification (CC).** The first faceted (analytico-synthetic) scheme, developed 1924–1933. Class numbers are *built* by analyzing a subject into facets and synthesizing them in the **PMEST** citation order: Personality, Matter, Energy, Space, Time [Britannica, LIS sources — see REFERENCES 38,39].

**Enumerative vs. faceted** — the distinction that matters to us:

| | enumerative (DDC, LCC) | faceted / analytico-synthetic (CC, UDC) |
|---|---|---|
| what's stored | every subject, pre-listed, with notation | facet schedules + combination rules |
| new subject | must be added to the register | falls out of combination for free |
| size | bulky | slim |
| cost | hard to design, easy to use | easy to design, harder to use |
| structure | one hierarchy | *n* orthogonal hierarchies + citation order |

[SYNTHESIS] **This is the deepest structural analogy for zodal-groups.** A faceted system is precisely "flat membership + projection": you don't store a tree of all compound subjects; you store *axis memberships* and a *rule for projecting them into a browsable order*. Any single browse tree (e.g. `Space → Time → Personality`) is one citation order among many. **Changing the citation order is changing the projection, with zero change to the data.** That is the file-system generalization we want, and it has been the state of the art in library science for 90 years.

**Hierarchical faceted metadata (the modern operational form).** Hearst et al.'s Flamenco work is the canonical HCI treatment: expose *hierarchical* facets, let users refine and expand, integrate keyword search with navigation, and — crucially — **never show a path to an empty result set** [31,36]. The last is a hard UX invariant we should adopt: a group/facet value that would yield 0 items *in the current context* should be suppressed or shown with its (zero) count, never offered as a live link.

**Where facets and hierarchy meet.** A facet value can itself be hierarchical (`location: Europe > France > Paris`). So a real system needs *both* axes: (a) which facet is this group on? (b) what is this group's position within that facet's own hierarchy? Z39.19's node labels are the low-tech encoding of (a) inside a single tree [3, §8.3.5].

---

## 3. Polyhierarchy proper — a node with multiple parents

### 3.1 ANSI/NISO Z39.19-2005 (R2010)

The standard is unusually clear and directly usable [3]:

- **Definition** (glossary): polyhierarchy = "a controlled vocabulary structure in which some terms belong to more than one hierarchy."
- **§8.3.4 Polyhierarchical Relationships**: "Some concepts belong, on logical grounds, to more than one category. They are then said to possess polyhierarchical relationships." It gives three flavours with worked examples:
  - **generic** polyhierarchy — `piano` is NT of both `stringed instruments` and `percussion instruments` (Ex. 109);
  - **whole-part** polyhierarchy — `biochemistry` under both `biology` and `chemistry` (Ex. 110);
  - **mixed-kind** polyhierarchy — `skull` is **BTG** `bones` (a kind of bone) *and* **BTP** `head` (part of the head) (Ex. 111–112).
- **§8.3.1 the all-and-some test** is the admission gate: `cacti` ⊂ `succulent plants` passes (all cacti are succulents); `cacti` vs `desert plants` **fails** (only *some* cacti are desert plants) → assign to different hierarchies and co-index instead.
- **§8.3.3.2 "Parts of Multiple Wholes"** — an under-appreciated rule with direct bearing on us: *"When a whole-part relationship is not exclusive to a pair of terms, i.e., the part can belong to multiple wholes, the name of the whole and its part(s) should **not** have a hierarchical relationship. Rather, they should be linked **associatively**."* Example: carburetors are parts of machines other than cars ⇒ `cars RT carburetors`, not BT/NT.

> **HARD FACT with a sting**: Z39.19 permits polyhierarchy for *generic* and *instance* relations, but for *whole-part* relations it tells you to **demote a multi-parent partitive edge to an associative edge** [3, §8.3.3.2]. In other words, the standard treats "this part is in many wholes" as a *signal that the edge isn't really hierarchical*.

[SYNTHESIS] This is a real, citable constraint we could offer as a lint rule / profile option: `partitiveEdgesMustBeExclusive: boolean`. It is also a warning: **an edge kind can be polyhierarchy-safe or polyhierarchy-unsafe.**

### 3.2 ISO 25964-1:2011

The successor international standard. Same three hierarchical relation kinds, expressed as properties: **`broaderGeneric` (BTG)**, **`broaderPartitive` (BTP)**, **`broaderInstantial` (BTI)** [30]. On polyhierarchy: "a single concept can occur in more than one place in the hierarchical structure … Its attributes and relationships … are the **same wherever it occurs**." [30]

> **This sentence is the specification of node identity under polyhierarchy**: one node, many positions; the node's properties do not vary by path. Any model where a node's payload depends on which parent you came through is *not* polyhierarchy — it's duplication. [30]

ISO 25964 also has **`ThesaurusArray`** (sibling concepts grouped under a node label) and **`ConceptGroup`** — again the Concept/Collection split [30].

### 3.3 SKOS (W3C Recommendation, 2009)

The most directly reusable formal model. Key normative facts [1] (integrity conditions cited by their spec numbers), with rationale from the Primer [2]:

1. **`skos:broader` / `skos:narrower` are inverse properties**, and **NOT transitive**. §8.6.6: "Note that `skos:broader` is not a transitive property." By convention they assert **direct** links only [1].
2. **`skos:broaderTransitive` / `skos:narrowerTransitive` ARE transitive** (`owl:TransitiveProperty`, S24), and `skos:broader` is a **sub-property** of `skos:broaderTransitive` (S22). So the closure is *derivable* but is not the asserted data [1].
   - The Primer's rationale for the split is the crux: SKOS refuses blanket transitivity because real KOSs are "messy hierarchies" that mix relation kinds — chains like *wheel* → *car* → *vehicle* would otherwise licence "a wheel is a kind of vehicle" [2]. **This is exactly our `poodle ⟹ dog ⟹ animal` question, and the standards body's answer is: don't assume; declare.**
3. **Polyhierarchy is explicitly permitted.** Example 38 asserts `<A> skos:broader <B>, <C>` and the spec labels it **consistent**, calling out "poly-hierarchical knowledge organization systems" [1].
4. **Cycles are NOT prohibited.** §8.6.8 states a cyclic graph is "consistent with the SKOS data model" [1]. There is no integrity condition against cycles or against alternate paths. This is a deliberate, and in my view mistaken-for-our-purposes, choice (see §4.1).
5. **`skos:related` is disjoint with `skos:broaderTransitive`** (S27) — and, because `related` is symmetric and the transitives are inverses, also with `narrowerTransitive` [1]. **This is the one real structural integrity condition SKOS gives you**: you may not say two concepts are *associatively* related if one is (transitively) broader than the other.
6. **`skos:Collection` is disjoint from `skos:Concept` and `skos:ConceptScheme`** (S37); `skos:member` has domain `Collection` and range `Concept ∪ Collection` (S31–32) — i.e. **collections may nest**; `skos:OrderedCollection` + `skos:memberList` add ordering, and S36 requires every member of the list to also be a `skos:member` [1]. Collections **must not** be used with `skos:broader` [2].
7. **Concept schemes**: `skos:inScheme`, `skos:hasTopConcept` ⟷ `skos:topConceptOf` (S7–S8). A concept may be in **multiple** schemes [1,2].
8. **SKOS concepts are OWL individuals, not OWL classes** [2] — a deliberate "don't make me commit to class semantics" move.

> **Design lesson from SKOS, stated bluntly** [SYNTHESIS]: SKOS separates **(a) the asserted edge**, **(b) the transitive closure of that edge**, and **(c) a grouping device that is deliberately outside the hierarchy**. Three concepts, three names, in the spec, because collapsing them causes bugs. zodal-groups needs the same three.

### 3.4 OWL — multiple `rdfs:subClassOf`

OWL/RDFS put no cardinality limit on `subClassOf`; multiple inheritance is native and `subClassOf` **is** transitive by definition. The polyhierarchy is thus a DAG of classes with automatic closure — which is why OWL is *stronger* than SKOS and why SKOS exists as the "I don't want entailment" option [1,2,28]. OWL 2's **profiles** (EL, QL, RL) then *restrict* the language to buy tractability [28] — see §7.

The programming-language analogue is instructive: multiple inheritance's **diamond problem** (D inherits from B and C, both from A) is resolved in Python/Dylan by **C3 linearization**, producing a deterministic, monotonic MRO in which each class appears exactly once and before its parents [33]. **The set-based analogue in a grouping system is trivial (ancestors are a *set*, so A appears once), but the *ordered* analogue — "in what order do I display the ancestor chain / which is the primary breadcrumb" — is exactly the diamond problem and has no free answer.** [SYNTHESIS]

### 3.5 MeSH — the biggest production polyhierarchy

- MeSH is **explicitly polyhierarchical**: "each descriptor appears in at least one location in the branches, and may appear in as many additional locations as appropriate" [4].
- The mechanism is **tree numbers**: a descriptor carries *one or more* tree-number strings (`A01.456.505.420`, `A09.371` for *Eye* — under both *face* and *sense organs*) [4,5]. The numbers "serve only to locate the descriptors in each tree and to alphabetize those at a given tree level" [4].
- In MeSH RDF this is modelled with **`meshv:treeNumber`** (descriptor → tree-number node) and **`meshv:parentTreeNumber`** (tree-number → tree-number). There is *also* a `meshv:broaderDescriptor` shortcut, and the docs warn that **naively following `broaderDescriptor` gives different results from walking `parentTreeNumber+`** [5].

> **This is the single most instructive production data point in this report.** MeSH's canonical structure is **positional** — the parent edges live between *positions* (tree numbers), not between *descriptors*. The descriptor-level "broader" relation is a lossy derived convenience that **doesn't agree with the tree walk** [5].
>
> [SYNTHESIS] MeSH is a cautionary tale about **materialized path as the primary key of the edge**. `A01.456.505.420` encodes the whole ancestor chain in a string; inserting a level renumbers the subtree; the descriptor-level shortcut then drifts. We should store `(child, parent)` edges and *derive* paths — never the reverse. See §4.5.

### 3.6 Gene Ontology — DAG, `is_a`/`part_of`, and the **true path rule**

- GO is a DAG: "a node … can have more than one parent … and **different relations to its different parents**" [6].
- **`is_a`** (subtype) and **`part_of`** (necessarily-part) are the two annotation-safe relations; **`regulates`** is *not* — "grouping annotations to gene products grouped via `regulates` changes the relationship between the GO term and the gene product" [6].
- **Relation composition is declared explicitly**: `is_a ∘ part_of → part_of` [6]. This is how GO earns the right to transitively close a mixed-relation chain.
- **The true path rule**: "the pathway from a child term all the way up to its top-level parent(s) must always be true"; operationally, "whenever a gene is annotated to a term it is also implicitly associated with **all the less specific parents** of that term," so "each term in GO shares all the annotations of all of its descendants" [6 and the bioinformatics literature, 40].

> **HARD FACT of great importance to us**: GO's true path rule is **read-time closure over annotations, made sound by declaring per-relation composition rules and by excluding relations (like `regulates`) for which closure is invalid** [6]. GO does *not* materialize the closure into the annotation records; it is an inference rule. This is the reference design for tag implication done right.

### 3.7 Wikipedia categories — the infamous one

- The guideline is explicit that **cycles are forbidden**: "Category chains formed by parent–child relationships should **never form closed loops**" [7]. And: pages "should not usually be placed in **both** a given category and any of its subcategories or parent categories" [7] — an *anti-redundancy* rule that only makes sense if consumers are expected to do transitive closure themselves.
- **In practice the graph has cycles anyway.** Zesch & Gurevych, analysing the German Wikipedia Category Graph (May 2006 snapshot): "Wikipedia does not strictly enforce a taxonomic category structure, **cycles and disconnected categories are possible, but rare**"; the largest connected component contained 99.8% of category nodes "as well as **7 cycles**" [8]. Their remedy is a **colored DFS that deletes back-edges** (an edge pointing to a node closer to the root), noting that when the cycle is between same-level nodes "we cannot decide based on that rule" [8]. English-Wikipedia analyses have found cycles up to length 22.
- The edges are not reliably `is_a`: category links "typically express hyponymy **or meronymy**" [8] — the exact relation-kind mixing that SKOS warns about.
- Independent corroboration from vocabulary QA: qSKOS found **cyclic hierarchical relations are rare except in collaboratively-created vocabularies** — DBpedia (derived from Wikipedia categories) had **1,132** cyclic-relation hits, mostly *reflexive* `skos:broader`; even MeSH had **5** [9].

> **Are cycles always wrong?** [SYNTHESIS] For *generic* (`is_a`) and *instance* edges, yes — a cycle is a logical contradiction (X is a strict subclass of itself). qSKOS's motivation section says exactly this, citing Soergel, Hedden, Harpring and Aitchison: for "generic-specific," "instance-of," or "whole-part" relations, "cycles would be considered a logical contradiction" [9]. For **associative** (`related`) or purely navigational "see also" edges, cycles are fine and expected (they're symmetric). Wikipedia's cycles are not a defence of cycles — they're a symptom of an unenforced, mixed-semantics edge type.
>
> **Recommendation: forbid cycles on any edge kind for which closure is enabled; permit them on associative edges.** That is a *derivable* rule, not an arbitrary one: if you take a transitive closure over a cyclic relation, every node in the cycle becomes an ancestor of itself, `isAncestor` becomes vacuously true within the strongly-connected component, and every "expand to descendants" query returns the whole SCC. Cycles are wrong exactly when closure is on.

---

## 4. The invariants a polyhierarchy must maintain

This is the operational core. Each invariant below is stated as: *what it is → what breaks → how real systems cope → recommendation.*

### 4.1 Acyclicity

- **SKOS does not require it** [1, §8.6.8]. **Wikipedia requires it and doesn't get it** [7,8]. **Danbooru enforces it in code**: TagImplication validation rejects `A→B→A` ("can not create a circular relation") [23]. **Unix enforces it structurally** by banning hard links to directories [37].
- **What breaks**: infinite traversal (`find` loops [37]); `isAncestor(x, x)` becomes true; ancestor/descendant sets collapse to the SCC; topological order and breadcrumb rendering become undefined; reference-counting GC leaks [37].
- **Cost of enforcement**: a cycle check on `addEdge(child, parent)` is a reachability query "is `child` an ancestor of `parent`?" — O(V+E) with DFS, or O(1) lookup if you maintain a closure table.
- ✅ **Recommendation**: acyclicity is a **profile-level invariant, default ON for hierarchical/closure-bearing edge kinds**, enforced at write time with an informative error naming the offending path. Provide `allowCycles: true` only for associative/`related` edge kinds. Also provide an *offline* `detectCycles()` + `breakCycles()` repair (back-edge deletion, à la Zesch & Gurevych [8]) for imported data.

### 4.2 The diamond problem / ancestor de-duplication

- Item in `A`; `A` under `B` and `C`; `B` and `C` both under `D`. Naive recursive traversal visits `D` **twice** and, in an unmemoised implementation, explores `D`'s subtree twice.
- **What breaks**: duplicated rows in "all ancestors of X" lists; **double-counted facet counts** (the classic bug: `D (2)` when there is one item); exponential blowup in deep DAGs (`2^depth` paths).
- **The set answer is easy; the ordered answer is not.** Ancestors are a *set* → de-dup by node id. But "which parent do I show first / which breadcrumb / which is 'the' path" is genuinely the diamond problem, and languages solve it with **C3 linearization** (deterministic, monotonic, each class once, before its parents) [33].
- ✅ **Recommendation**:
  - Every traversal API returns **`Set<GroupId>`**, never `Array` with dups, and is **memoised** (visited-set) — a hard correctness requirement, not an optimisation.
  - **Counts must be computed over de-duplicated item sets**, i.e. `count(D) = |{ items i : D ∈ ancestorsOf(i) }|`, never `Σ over paths`. Otherwise facet counts lie. *(This is a bug I would bet money on shipping in v1 if we don't write it down now.)*
  - For ordering, expose an explicit `primaryParent` (see 4.4) rather than inventing an MRO.

### 4.3 Transitive inheritance / tag implication — **the biggest semantic choice**

The question: *item tagged `poodle`; `poodle ⟶ dog ⟶ animal`. Is the item in `animal`?*

**The standards do not agree, and that disagreement is itself the finding.**

| system | closure semantics | how |
|---|---|---|
| **OWL** | always, by definition | `rdfs:subClassOf` is transitive; entailment [28] |
| **GO** | always, at read time — the **true path rule** | annotation to a term implies annotation to all less-specific parents; made sound by declared relation composition (`is_a ∘ part_of → part_of`) and by **excluding** unsafe relations (`regulates`) [6] |
| **SKOS** | **only if you ask** | `broader` is deliberately non-transitive; `broaderTransitive` is available as a superproperty for consumers who want closure. Rationale: mixed-kind chains (wheel→car→vehicle) are unsound [1,2] |
| **Z39.19 / ISO 25964** | implicitly yes, gated by **all-and-some**; and *forbids* the multi-parent partitive case that would break it [3, §8.3.1, §8.3.3.2] |
| **Danbooru** | **write-time materialization** — `TagImplication#process!` "updates all posts with the child tag"; "if `sword` implies `weapon`, any post tagged with `sword` will automatically receive the `weapon` tag." Chains `A→B→C` are *prevented*, not expanded [23] |
| **Obsidian** | read-time, by **string prefix**: "`tag:inbox` will match `#inbox` as well as all nested tags such as `#inbox/to-read`" [16] |
| **Tana** | read-time: "If you search for a higher-level (parent) tag, all its descendants will also turn up in the search results" [18] |
| **Zotero** | **read-time, and it's a user-toggleable VIEW OPTION**: "items added to a subcollection do not automatically appear in parent collections" — unless you enable **View → Show Items from Subcollections** [15] |
| **Wikipedia** | **no closure in the UI** — a category page lists only direct members, and the guideline actively tells you *not* to duplicate a page into both a category and its subcategory [7] |
| **Logseq** | **broken**: namespace queries do *not* pick up lower levels — a task on `Golf/Level1/Level2` is not found by a query on `Golf` [34] |

> **Zotero's `Show Items from Subcollections` toggle is the single best piece of evidence for our thesis** [15]: the *same edge data* renders as a strict-containment tree or a closure-expanded tree depending on **a view flag**. That is literally "the hierarchy is a projection."

**Write-time (materialize) vs read-time (expand)** — the trade table [SYNTHESIS, informed by 6,15,23,32]:

| | **write-time materialization** (Danbooru) | **read-time expansion** (GO, Zotero, Tana, Obsidian) |
|---|---|---|
| read cost | O(1) — closure is already in the row | O(depth) or one closure-table join |
| write cost | O(descendants × items) — approving one implication rewrites *every affected post* [23] | O(1) |
| re-parenting | **must re-run the whole materialization**; stale rows if you miss one | free — next read reflects it |
| provenance | **lost**: you cannot tell "user tagged this `animal`" from "the system inferred it". Danbooru mitigates by preventing chains [23] | preserved: asserted edges stay asserted |
| deletion | removing the implication does **not** un-tag posts (Danbooru "rejects" the relationship; historical data persists) [23] | automatic |
| offline / sync | works — the data is self-contained | needs the group graph present |
| standards alignment | none of the standards do this | SKOS, GO, ISO all do this |

> ### 🔴 OPEN DECISION 1 — Closure semantics
>
> **Options**
> - **(a) Read-time only.** Store asserted edges. `expand: 'closure' | 'direct'` is a *query/projection parameter*. Materialize nothing.
> - **(b) Write-time only.** Materialize implied memberships into the item's membership set.
> - **(c) Read-time semantics + optional materialized closure table as a pure cache** (invalidated on edge mutation), i.e. the closure is derived but *indexed*.
>
> **Recommendation: (c).** Semantics are read-time (matching SKOS, GO, ISO, Zotero); *performance* is served by an optional, provider-declared closure index that is a **cache, not truth**. This preserves provenance (asserted vs. inferred is always distinguishable), makes re-parenting cheap and correct, and lets a store adapter that *can* maintain a closure table (Postgres recursive CTE + trigger; a `closure` table à la Karwin [32]) opt in via a capability flag — exactly the `getCapabilities()` pattern already established across `zodal-store-*`.
>
> **Corollary — closure must be per-edge-kind, not global.** Follow SKOS/GO: an edge kind declares `transitive: true|false` and (optionally) composition rules. Default `transitive: true` for `is_a`-like kinds and `false` for `related`-like kinds. Never let a `related` edge participate in closure (SKOS integrity condition S27 makes this a *hard* constraint: `related` is disjoint from `broaderTransitive` [1]).

### 4.4 "Which paths lead to this node" — one path vs. many

In a tree, `path(node)` is a function. In a DAG, `paths(node)` is a **set**, potentially exponential in depth.

- **What breaks**: breadcrumbs ("you are here" is now "you are in one of 7 heres"); deep links / permalinks; "reveal in sidebar"; drag-and-drop *out of* a location (which membership are you removing?); URL routing.
- **How systems cope**:
  - **NN/g**: sites must nonetheless show *one* "canonical" breadcrumb path for technical and SEO reasons — the displayed path may differ from the user's actual navigation route [10]. They recommend using polyhierarchy **with restraint** and, where category overlap is heavy, using **faceted search instead of exhaustive polyhierarchy** [10].
  - **MeSH**: gives each *position* an identity (tree number), so a descriptor's occurrences are individually addressable [4,5].
  - **Gmail/Obsidian/Bear/Logseq**: sidestep it entirely — the "path" is the tag's own name, so there is exactly one, at the price of no polyhierarchy at all [16,17,21,34].
  - **Hedden**: >2 broader concepts, or multiple polyhierarchies on one concept, is a **design smell** requiring review; keep a "dominant hierarchy design" [11].
- ✅ [SYNTHESIS] **Recommendation**: model **`Route`** (a path through the DAG) as a first-class *derived* object, distinct from **`GroupId`** (node identity). UI state is `(groupId, routeTaken?)`. Offer:
  - `primaryParent?: GroupId` on the edge or the node — an explicit, author-chosen canonical parent used for breadcrumbs/URLs. (This is the honest version of what NN/g says sites do anyway [10].)
  - `allPaths(node): Route[]` with a **depth/branch cap** and a documented ordering — never unbounded.
  - `contextualBreadcrumb` = the route the user actually navigated (session state), falling back to the primary path.
  - A lint: `warn if parents(node).length > maxRecommendedParents (default 2)` [11].

### 4.5 Re-parenting semantics and invalidation

`moveEdge(child, oldParent, newParent)` / `addParent` / `removeParent`.

**What must be invalidated** [SYNTHESIS, derived from the structures above]:

| stored artifact | invalidated by a re-parent? |
|---|---|
| asserted edge set | (this *is* the mutation) |
| **materialized closure** (ancestor/descendant table) | **YES** — for the whole subtree under `child`, on both the removed and added side |
| **materialized path / tree-number strings** | **YES, catastrophically** — every descendant's path string changes. This is MeSH's structural cost [5] and the classic closure-table-vs-path-enumeration trade [32] |
| **facet/group counts** | YES for every node on the old and new ancestor chains |
| **write-time-materialized item tags** (Danbooru-style) | YES — must re-run implication processing over all items under the subtree [23] |
| **nested-set left/right values** | YES — nested sets are near-unusable under frequent re-parenting [32] |
| **item→group edges** | NO — untouched. *This is the payoff of the canonical-membership thesis.* |
| **cycle-freedom** | must be **re-checked** before commit: `newParent` must not be a descendant of `child` |

> **The killer argument for the thesis, restated as an invalidation table** [SYNTHESIS]: under "membership is canonical," re-parenting a group touches **only the group→group edge table**. Under "path is canonical" (filesystems, Gmail label names, Obsidian/Bear/Logseq tags, MeSH tree numbers), re-parenting rewrites **every descendant and, in the tag-as-string designs, every *item*.** Renaming `#work` to `#job` in Obsidian rewrites every note that mentions `#work/*`. That's not a projection difference; that's an O(items) migration.

**Storage patterns and their re-parent cost** [32, and the general SQL literature]:

| model | read descendants | re-parent | polyhierarchy? |
|---|---|---|---|
| **adjacency list** (`parent_id`) | recursive CTE | O(1) | ❌ single parent by construction |
| **edge table** (`(child, parent)` rows) | recursive CTE | O(1) per edge | ✅ **natively** |
| **materialized path** (`/a/b/c`) | prefix scan (fast) | O(descendants) rewrite | ❌ (one path per node) |
| **nested sets** (`lft`, `rgt`) | range scan (fastest reads) | O(n) renumber | ❌ |
| **closure table** (all ancestor–descendant pairs) | single join (fast) | O(descendants × ancestors) | ✅ — "a DAG is a more general version of a closure table" |

✅ **Recommendation**: the canonical store is an **edge table**; the closure table is an optional derived index (OPEN DECISION 1c). **Materialized path and nested sets are disqualified** — they cannot represent polyhierarchy at all.

### 4.6 Other invariants worth stealing (from qSKOS's empirically-validated issue list [9])

qSKOS defines 26 computable quality issues and found problems in **all 24** vocabularies it analysed [9]. The structural ones map 1:1 onto lint rules we should ship:

| qSKOS issue | definition | our lint |
|---|---|---|
| **Cyclic Hierarchical Relations** | cycles in the `broader` graph; a "logical contradiction" for generic/instance/whole-part relations | `noCycles` (error) |
| **Orphan Concepts** | a concept with *no* semantic relation to any other concept | `orphanGroup` (warn) — a group with no parent, no child, no members |
| **Weakly Connected Components** | the vocabulary splits into disjoint clusters (deleted relations, bad imports) | `disconnectedCluster` (info) |
| **Valueless Associative Relations** | two concepts sharing a broader concept that are *also* `related` — an association justified only by siblinghood; ISO/DIS 25964-1 says don't | `redundantRelated` (warn) |
| **Solely Transitively Related Concepts** | asserting `broaderTransitive` directly instead of `broader` — a misreading of the spec that "could result in a loss in recall on hierarchical queries" | in our terms: **asserting an inferred edge as if it were direct** (warn) |
| **Omitted Top Concepts** | a scheme with no declared entry points | `noRoots` (warn) — a group graph with no roots is either cyclic or has no browse entry |
| **Top Concept Having Broader Concepts** | a declared root that isn't a root | `rootHasParent` (error) |

Plus one Z39.19-derived rule: **`multiParentPartitive`** — a `part_of` edge whose child has >1 parent should probably be an associative edge [3, §8.3.3.2].

---

## 5. Hierarchical tagging in the wild — path-as-string vs. real parent edges

The single most decision-relevant axis. **"Is the tag namespace a real hierarchy, or a string with slashes?"**

### 5.1 The **path-as-string** camp (nesting is a naming convention)

| tool | mechanism | closure behaviour | polyhierarchy? | rename/reparent |
|---|---|---|---|---|
| **Gmail / Workspace labels** | The `Label` resource has `id`, `name`, `type`, colors, counts — **no `parent` field**. Nesting is entirely in `name`: `"Social Media/Facebook/Notifications"` **is one label**, not four [21,22]. IMAP maps each label to a folder, so a multi-labelled message appears in several folders [Gmail IMAP behaviour]. | n/a (labels are flat; the tree is UI sugar) | ❌ for labels; ✅ for messages (many labels per message — the canonical "folders that aren't folders") [22] | rename = rewrite the string |
| **Obsidian** | `#parent/child`. **Official docs**: "Nested tags define tag hierarchies… Create nested tags by using forward slashes"; "In Search, `tag:inbox` will match `#inbox` as well as all nested tags such as `#inbox/to-read`" [16] | ✅ **read-time, via string prefix match** | ❌ — a tag's parent *is* its prefix, so exactly one | rename = rewrite every note |
| **Bear** | `#Novel/chapter/1`; "the `/` symbol tells Bear to manage the tag as a hierarchy"; unlimited depth [17] | prefix-based | ❌ | string rewrite |
| **Logseq** | `[[Area/Project/Topic]]` namespaces | ❌ **broken**: "namespaces in queries for tasks don't pick up lower levels in the hierarchy" — a TODO on `Golf/Level1/Level2` is not found by a query on `Golf` [34] | ❌ | string rewrite |

> **Verdict on path-as-string** [SYNTHESIS]: it is *seductive* — zero schema, free tree rendering, free closure via `startsWith`. And it is a **trap**:
> 1. **One parent, structurally.** A tag's parent is its prefix. You cannot express `#poodle` under both `#dog` and `#curly-haired`. Polyhierarchy is *unrepresentable*, not merely unsupported.
> 2. **Rename is O(items).** Renaming a parent rewrites every item.
> 3. **The hierarchy is not addressable.** You cannot attach metadata (description, colour, icon, edge kind) to the *relationship* `dog → animal`, because there is no such object.
> 4. **Closure by `startsWith` is a lie you can't turn off.** Obsidian's `tag:inbox` *always* matches children [16]. Zotero's toggle [15] proves that's sometimes the wrong default.
> 5. **Logseq shows how the illusion breaks** the moment you want a real query [34].
>
> **zodal-groups must NOT make path-as-string the canonical model.** It may *offer it as a serialization/DX affordance* (`"a/b/c"` sugar that compiles to real edges) — but the edges are the truth.

### 5.2 The **real-edges** camp

| tool | model | key facts |
|---|---|---|
| **Zotero** | Collections form a hierarchy; **an item may be in many collections**; "adding an item to multiple collections **does not duplicate** the item"; "think of collections like playlists rather than folders." Tags are **flat**. **Saved searches = smart collections**, auto-updating. **`Show Items from Subcollections` is a view toggle.** Notably: "tags are portable, but collections are not" — collections don't survive a cross-library copy [15] | The reference model for us. Also the reference *warning*: their collection graph is still a **tree** (one parent per collection); only *items* are multi-parent. |
| **Are.na** | **Blocks** and **Channels**. "Any block can be reused in multiple channels (this is called a **connection**)"; blocks "can be connected to an infinite number of channels." **"You can put a channel into another channel, and then they act as blocks."** A channel header shows **"This channel appears in"** [19,20]. The block resource exposes a `connections` attribute listing the channels it appears in [20] | **The closest existing product to zodal-groups.** Full polyhierarchy for *both* items and groups; groups are themselves items (channel-as-block); "connection" is the canonical edge; the reverse index is a first-class UI element. |
| **DEVONthink** | **Replicant** vs **Duplicate**. A replicant "is not a copy… it's a clone… **there is no original** when dealing with replicants, because all replicants are just instances of one item"; edits to any replicant affect all. Used precisely "when you want to file something in multiple locations." Constraints: same database only; **cannot replicate an item into the same group twice** [24] | A UI-level admission that "one item, many places" is what people actually want — bolted onto a tree file model. The "cannot replicate into the same group twice" rule = **edge set has set semantics**, not multiset. |
| **Tana** | **Supertags** turn a node into a typed object; a supertag can **`extend`** another (single parent), inheriting its fields; **a node can carry multiple supertags**; and "if you search for a higher-level (parent) tag, **all its descendants will also turn up** in the search results" [18] | Real parent edges *between tags*, with **field inheritance** and **read-time closure in search**. Multi-tag on items = polyhierarchy at the item level. Supertag `extend` is single-parent — a deliberate simplification. |
| **MeSH** | tree numbers; multi-position descriptors [4,5] | see §3.5 |
| **Gene Ontology** | DAG, per-relation composition, true path rule [6] | see §3.6 |
| **Wikipedia** | category edges; cycles forbidden but present [7,8] | see §3.7 |
| **Stack Overflow** | flat tags; **tag synonyms** map an antecedent tag to a canonical one (auto-retag on post), plus tag wikis. **No tag hierarchy / no sub-tags.** ⚠️ **[MEDIUM CONFIDENCE — the SO help page could not be fetched from this environment; treat the mechanism as well-established but the details as unverified.]** | The interesting datum is the *negative* one: the largest tag system in software deliberately has **no** hierarchy, only synonyms (= a **synonym ring** in Z39.19's sense [3, §5.4.2]). |
| **Danbooru / boorus** | **TagAlias** (`antecedent → consequent`, read-time substitution; **chains `A→B→C` are blocked**) + **TagImplication** (`sword ⟹ weapon`; `TagImplication#process!` **materializes** the consequent onto every affected post at approval time; circular and redundant-transitive implications are rejected by validation) [23] | The most explicit **write-time closure** system in the wild, and it needed *three* validators (no cycles, no chains, no redundancy) to stay sane. Also shows the cost: undoing an implication does *not* un-tag posts [23]. |
| **Notion** | Pages have a single parent (tree). Cross-cutting membership is done with **Relation** properties between databases, which can be limited to **1 page** or **No limit** — i.e. many-to-many is opt-in per property [35] | Notion's "hierarchy" and its "grouping" are two different mechanisms. Worth noting as the *split-brain* anti-pattern. |

### 5.3 The **query-as-group** camp (intensional groups)

| system | mechanism |
|---|---|
| **BeOS / BFS** | The filesystem supports **extended attributes (name/value pairs)**, **indexes** those attributes, and exposes a **query interface** "to provide functionality similar to that of a relational database" — a *non-hierarchical* way to locate files alongside the normal name-based hierarchical interface [25]. Giampaolo's book covers attribute indexing, the query language, and **live queries** (queries that stay open and update as files change) [26]. BeOS shipped email and contacts as *attributed files* found by query, not by folder. |
| **macOS Smart Folders / Spotlight** | A Smart Folder "isn't a folder at all, but rather a `.savedSearch` file… an XML file which tells the Finder what you searched for"; the results are always current; the folder can be moved or copied to another Mac and "wherever it goes it performs the same search" [27]. Get Info shows the underlying Spotlight **predicate** [27]. |
| **Gmail filters, iTunes/Navidrome smart playlists, Zotero saved searches** | Same shape: a *stored predicate* whose extension is computed on demand [15,27]. |

> [SYNTHESIS] Note the beautiful property of the `.savedSearch` file: **the intensional group is itself an item in the extensional hierarchy.** It has a path, a name, an icon. This is the correct integration: an intensional group is a *group whose members are derived*, and it is otherwise a first-class citizen — it can itself be a member of other groups, be tagged, be renamed.

---

## 6. Set-theoretic / algebraic framing

### 6.1 The core algebra

Let:
- `I` = items, `G` = groups, `N = I ⊎ G` (nodes).
- `M ⊆ N × G` = **membership relation** (`(n, g) ∈ M` ⟺ *n is a member of g*). Its restriction `M ∩ (I × G)` is a **bipartite relation** (items→groups); `M ∩ (G × G)` is the **group graph**.
- The group graph, if acyclic, induces a **strict partial order** `<` on `G` via its transitive closure: `g < h` ⟺ *h is a proper ancestor of g*. A partial order + acyclicity is *exactly* a DAG (up to transitive reduction).
- The item-extent of a group is `ext(g) = { i ∈ I : (i, g) ∈ M }` (**direct**) and `ext*(g) = { i ∈ I : ∃h ≤ g . (i, h) ∈ M }` (**closed**). §4.3's open decision is precisely *"which of `ext` / `ext*` is `getItems(g)`?"*

**Everything else is a projection**:
- a **tree view** = pick a spanning tree of the DAG (via `primaryParent`) and render;
- a **tag cloud** = render `G` with `|ext*(g)|` as the weight, discarding `<`;
- a **facet browser** = partition `G` into facets `F₁…Fₖ` (by a `facet` attribute on the group), render each `Fᵢ` independently, and intersect: `result = ⋂ᵢ ext*(gᵢ)` for the selected `gᵢ` — **the standard faceted-search algebra** [31,36];
- a **filesystem** = the profile `maxParents(item) = 1 ∧ maxParents(group) = 1` plus a materialized-path projection.

### 6.2 Intensional vs. extensional — use the Datalog names

The exactly-right, citable terminology comes from **Datalog** [14]:
- the **EDB** (*extensional database*) = "the set of **facts**" — your asserted edges;
- the **IDB** (*intensional database*) = "the set of tuples **computed by evaluating** the program" — derived membership.
- **Transitive closure is Datalog's prototypical example** (`ancestor(X,Y) :- parent(X,Y). ancestor(X,Z) :- parent(X,Y), ancestor(Y,Z).`) [14].
- **Bottom-up (naive / semi-naive) evaluation = materialization**; **top-down (SLD) evaluation = on-demand** [14]. *This is precisely the write-time-vs-read-time axis of §4.3, and it has a 40-year-old literature and a name.*

> **Terminology recommendation** [SYNTHESIS]: call an explicit-member-list group **extensional** and a predicate/query-defined group **intensional** (Datalog's own words [14]). Do **not** invent "smart group / static group" as the primitive names — expose those as *labels* in the UI if you like, but the model's vocabulary should be EDB/IDB-aligned. The whole system then has a crisp reading: **asserted membership edges + group→group edges = EDB; closure + intensional groups' extents = IDB; every view = a query over EDB ∪ IDB.**

**Semantics of mixing them** [SYNTHESIS — this is a genuine design hazard]:
1. **Can an intensional group have explicit members?** (a "smart playlist you can also drag things into"). If yes, `ext(g) = query(g) ∪ explicit(g)` — a **union**, and you must decide whether explicit *removals* are also stored (a tombstone set: `ext(g) = (query(g) ∪ added(g)) \ removed(g)`). iTunes-style smart playlists say no; some apps say yes and it's confusing.
2. **Can an intensional group be a *parent* of another group?** If group membership is itself query-derived, the group DAG becomes dynamic and **acyclicity is no longer statically checkable** — a query could, at some future data state, make `g` its own ancestor. This is the stratification problem, and Datalog's answer is **stratified negation / stratified evaluation** [14].
3. **Can an intensional group's predicate refer to group membership?** (`"all items in #dog"`). Yes — and then closure and the query engine are mutually recursive. Datalog handles this (that's what it's *for*); an ad-hoc filter engine will not.

> ### 🔴 OPEN DECISION 2 — Intensional groups: how deep does the rabbit hole go?
>
> - **(a) Intensional groups are leaf-only**: they may not be parents of other groups, and their predicates may not reference group membership. → acyclicity stays statically checkable; the group DAG is pure EDB. **Simple, sound, boring.**
> - **(b) Intensional groups are fully first-class**: they can parent groups and query over membership. → you need stratification, a fixpoint evaluator, and cycle detection *at query time*. This is a Datalog engine.
> - **(c) Hybrid**: intensional groups may be members/parents (structure is EDB), but their *member predicate* may not reference membership of groups that (transitively) contain them. → a static "no recursion through intension" check. Middle ground.
>
> **Recommendation: (c), shipped as (a) in v1.** Reserve the schema shape for (c); implement the leaf-only restriction first and error clearly (`"intensional groups may not currently be used as parents"`). Do not build a Datalog engine.
>
> **Secondary recommendation**: an intensional group's extent is **always IDB** — never write it back into the membership table. Anything else and you get the Danbooru un-tag problem: you can't tell whether the item was put there by a human or by a rule that no longer exists [23].

### 6.3 Formal Concept Analysis — honest assessment

FCA formalizes a **formal context** `K = (G, M, I)` (objects, attributes, incidence) — *literally our bipartite membership relation* — and derives, via a **Galois connection**, the set of **formal concepts** `(extent, intent)` where extent = all objects sharing the intent and intent = all attributes shared by the extent. These order into a **complete concept lattice**, and the basic theorem says every complete lattice is the concept lattice of some context [13]. FCA also yields **implications** `A → B` and a canonical (Duquenne–Guigues) basis from which all valid implications follow [13].

**Why it's tempting**: it is, on paper, *exactly* "facets + hierarchy, derived rather than authored." Given only item→tag edges, FCA *computes* the hierarchy, including the polyhierarchy, including the implications (`poodle → dog`).

**Why it is practically marginal for us** — be honest:
1. **Size.** "The number of concepts may be **exponential in the size of the formal context**" [13]; counting them is #P-complete. Wikipedia's own gloss ("lattices with a few million elements can be handled without problems" [13]) is a *reassurance about the tool*, not about a UI: a few million nodes is not a browsable hierarchy.
2. **The derived lattice is not the authored hierarchy.** FCA gives you *every* closed attribute-set, including thousands of accidental ones ("items tagged both `blue` and `2019`"). Users want the ~40 concepts they authored, not the 2^n they implied.
3. **Instability.** Adding one object can restructure the lattice. Bad for a UI that must be spatially stable.
4. **No relation kinds.** FCA's implications are purely extensional; it cannot distinguish `is_a` from `part_of`, which §3 established is the load-bearing distinction.

✅ **Verdict**: **do not build on FCA.** But it earns a place in two narrow, high-value spots:
- **A "suggest implications" lint** — the Duquenne–Guigues basis over the current data answers "every item tagged `poodle` is also tagged `dog`; should `poodle ⟹ dog` be an edge?" That's a genuinely nice authoring affordance and is cheap on a *filtered* context.
- **Documentation** — it's the right citation for *why* the extent/intent duality is the natural mathematical frame [13].

---

## 7. Constraint profiles — prior art, and the vocabulary we need

### 7.1 Does anyone parameterize a classification system by explicit constraints?

**Short answer: not for *grouping systems*, no. But the *pattern* is standard practice in adjacent W3C/ISO work, and we should name it accordingly.** [SYNTHESIS, with the following support]

**Prior art for "profiles as constrained subsets of one model":**

1. **OWL 2 Profiles (EL / QL / RL)** — the canonical example. Three "sublanguages (syntactic subsets) of OWL 2 with useful computational properties"; each "trades some expressivity to provide more desirable computational guarantees," and "by restricting the supported features **syntactically**, each OWL profile defines a subset of ontologies for which standard reasoning tasks are **tractable**" [28]. Choice of profile depends on "the expressiveness required by the application… the size of datasets and importance of scalability" [28].
   > **This is exactly our story, one level up**: *one model, several named restrictions, each buying a guarantee.* We should steal the word **profile** and the framing "a profile is a set of restrictions that buys you a guarantee."
2. **SHACL** — a W3C Recommendation for *validating* graphs against **shapes**, with `sh:NodeShape` / `sh:PropertyShape`, `sh:path`, cardinality (`sh:minCount` / **`sh:maxCount`**), `sh:class`, `sh:in`, `sh:pattern`, and **`sh:closed`** (no properties beyond those declared) [29]. Validation yields a conformance report with per-violation messages [29].
   > **`sh:maxCount` on a `broader` path is literally `maxParents`.** SHACL is the closest thing to an existing constraint language for our problem, and it is *graph-shaped* rather than tree-shaped. Worth citing as design precedent for the *shape of the API* (declare shapes → validate → structured report).
3. **Z39.19's four vocabulary types** — list ⊂ synonym ring ⊂ taxonomy ⊂ thesaurus, presented explicitly as a *ladder of increasing structural commitment*, where "the more complex vocabularies (taxonomies, thesauri) **include** the simpler structures (lists, synonym rings)" [3, §5.4].
   > **This is a constraint-profile ladder in all but name, from 2005**, and it is the right *content* for our profiles: `flat` (list) → `flat + aliases` (synonym ring) → `tree`/`dag` (taxonomy) → `dag + typed edges + associative + equivalence` (thesaurus).
4. **The Unix filesystem** — as established in §0, `maxParents(item) = ∞, maxParents(group) = 1` is a constraint profile chosen to buy acyclicity and refcount-GC [37].
5. **SKOS itself** is arguably a profile of OWL ("SKOS concepts are OWL individuals, not classes" [2]) chosen to *avoid* entailment commitments.

**Gap [SYNTHESIS]: nobody ships a grouping/tagging library that lets you say `{maxDepth: 3, maxParentsPerItem: 5, groupsMayContainGroups: false}` and get a validated, type-safe model out.** The pieces all exist (SHACL can express it; Z39.19 describes the ladder; OWL profiles establish the pattern), but there is no TS/Zod-native, projection-aware implementation. **That is the whitespace zodal-groups occupies.**

### 7.2 The constraint vocabulary we'd need

[SYNTHESIS] Derived from every failure mode catalogued above. Names chosen to echo SHACL (`max…`), Z39.19 (`polyhierarchy`, `nodeLabel`), and SKOS (`transitive`, `related`).

**Structural constraints (on the node/edge graph)**

| constraint | type | default | buys you | source of the idea |
|---|---|---|---|---|
| `maxParentsPerItem` | `number \| null` | `null` (∞) | `1` ⇒ classic folders | Unix files [37] |
| `maxParentsPerGroup` | `number \| null` | `null` (∞) | `1` ⇒ group graph is a **forest** ⇒ acyclicity for free, single path, cheap breadcrumbs | Unix directories [37]; Tana `extend` [18]; Zotero collections [15] |
| `maxDepth` | `number \| null` | `null` | `0` ⇒ **flat tagging**; `1` ⇒ one level of grouping | Z39.19 list vs taxonomy [3] |
| `allowCycles` | `boolean` | `false` | acyclicity ⇒ closure is well-defined | [3,7,9,23,37] |
| `groupsMayContainGroups` | `boolean` | `true` | `false` ⇒ **flat tag namespace** (Stack Overflow, Zotero tags) | [3, §5.4.1], [15] |
| `groupsMayContainItems` | `boolean` | `true` | `false` ⇒ **groups-of-groups-only** (a pure classification skeleton; items attach only at leaves) | derived |
| `groupsAreItems` | `boolean` | `false` | `true` ⇒ a group can be a member of a group *as an item* (Are.na channel-as-block); also lets you tag a group | Are.na [19,20]; SKOS `member` range `Concept ∪ Collection` [1] |
| `maxGroupsPerItem` | `number \| null` | `null` | the "how many tags may an item carry" dial | derived |
| `requireSingleRoot` / `roots` | `boolean` / declared | `false` | entry points for browse | SKOS `hasTopConcept` [1]; qSKOS "Omitted Top Concepts" [9] |
| `partitiveEdgesMustBeExclusive` | `boolean` | `false` | Z39.19 §8.3.3.2 compliance | [3] |

**Semantic constraints (on edge kinds)** — *the part most libraries forget*

| field | type | notes |
|---|---|---|
| `edgeKinds` | `Record<string, EdgeKindDef>` | e.g. `is_a`, `part_of`, `instance_of`, `related`, `member_of` |
| `EdgeKindDef.transitive` | `boolean` | SKOS's `broader` (false) vs `broaderTransitive` (true) [1] |
| `EdgeKindDef.symmetric` | `boolean` | `related` is symmetric [1] |
| `EdgeKindDef.acyclic` | `boolean` | must be `true` if `transitive` |
| `EdgeKindDef.composesWith` | `Record<EdgeKind, EdgeKind>` | GO's `is_a ∘ part_of → part_of` [6] |
| `EdgeKindDef.disjointWith` | `EdgeKind[]` | SKOS S27: `related` ⊥ `broaderTransitive` [1] |
| `EdgeKindDef.inheritsAffordances` | `boolean` | Tana-style field inheritance down `extend` [18] |

**Projection parameters (not constraints — *view* options)**

| param | values | notes |
|---|---|---|
| `expand` | `'direct' \| 'closure'` | **Zotero's `Show Items from Subcollections`** [15] |
| `pathStrategy` | `'primary' \| 'all' \| 'contextual'` | breadcrumbs under polyhierarchy [10] |
| `citationOrder` | `FacetId[]` | which facet is the outer browse axis — Ranganathan's PMEST, generalized |
| `countMode` | `'direct' \| 'closed'` | and **always de-duplicated** (§4.2) |
| `emptyGroups` | `'hide' \| 'show' \| 'disable'` | Flamenco: never navigate to zero results [31,36] |

**Named profiles [SYNTHESIS]** — the "simple things simple" layer:

| profile | expansion |
|---|---|
| `filesystem` | `maxParentsPerItem: 1, maxParentsPerGroup: 1, allowCycles: false, groupsMayContainGroups: true` |
| `flatTags` | `maxDepth: 0, groupsMayContainGroups: false, maxGroupsPerItem: null` |
| `nestedTags` | `maxParentsPerGroup: 1, groupsMayContainGroups: true` (Obsidian/Bear semantics — *but with real edges*) |
| `labels` | `maxParentsPerItem: null, maxParentsPerGroup: 1` (Gmail: items multi-parent, label tree is a tree) |
| `polyhierarchy` | all defaults; `allowCycles: false` |
| `thesaurus` | `polyhierarchy` + typed `edgeKinds` (`is_a`/`part_of`/`instance_of`) + `related` + aliases |
| `folksonomy` | `flatTags` + per-user membership edges (the `(tag, object, identity)` triple [12]) |

> ### 🔴 OPEN DECISION 3 — Is the profile a *validator* or a *type-level constraint*?
>
> - **(a) Runtime validation only** (SHACL-style): the model is always the general one; the profile is a set of checks run on mutation, producing a structured report [29].
> - **(b) Type-level narrowing**: `defineGroups({ profile: 'filesystem' })` returns a type where `parents: [GroupId]` (a 1-tuple) rather than `GroupId[]`, so `maxParentsPerGroup: 1` is a *compile-time* fact.
> - **(c) Both.**
>
> **Recommendation: (c), with (a) as the foundation.** The runtime validator is the SSOT (it must exist anyway — data can arrive from a store adapter that doesn't know the profile). Type-level narrowing is applied where it's cheap and high-value: `maxParents: 1` ⇒ `parent: GroupId | null` instead of `parents: GroupId[]`; `maxDepth: 0` ⇒ no `parents` field at all. This is exactly the "progressive disclosure" principle: a `flatTags` user should never see a `parents` field in their types.

> ### 🔴 OPEN DECISION 4 — Is the item→group edge *reified*?
>
> Does `(item, group)` carry data (who added it, when, edge kind, confidence, position/order)? Are.na's `connections` are reified (they have authors and timestamps) [19,20]. SKOS's `skos:member` is not. An unreified edge is a `Set<[NodeId, GroupId]>`; a reified edge is a first-class entity with an id.
>
> **Recommendation: reify, but make the payload optional and default-empty.** The costs are small; the things it unlocks are large: provenance (asserted-by-human vs. inferred-by-rule — see §4.3), ordering within a group (SKOS `OrderedCollection` [1]), per-edge kind (`skull --BTG--> bones`, `skull --BTP--> head` [3, Ex. 112]), and the `(tag, object, identity)` triple that makes folksonomy expressible at all [12]. Without a reified edge, **you cannot represent a folksonomy**, and you cannot distinguish user-asserted from rule-inferred membership.

> ### 🔴 OPEN DECISION 5 — Are groups items? (`groupsAreItems`)
>
> Are.na says yes (a channel *is* a block; you can connect a channel into a channel) [19,20]. SKOS says **no** — `Collection` is disjoint from `Concept` [1, S37] — and Z39.19 agrees (node labels "must not be used as indexing terms" [3]). File systems say sort-of (a directory is a file, but with a special type and a hard-link restriction [37]).
>
> **Recommendation: make it a profile flag, default `false`, and design the type system so it can be `true`.** Concretely: `Member = Item | Group` as a discriminated union from day one, even if the default profile rejects `Group` in the item position. Retrofitting this later is a breaking change to every store adapter's `getList` signature — and Are.na's model is popular for good reason.

---

## 8. Gaps and honest caveats

- **Stack Overflow**: `stackoverflow.com` is unfetchable from this environment. Tag-synonym mechanics above are stated at medium confidence.
- **BeOS live queries**: the *live* query mechanism is documented in Giampaolo's book [26], which I did not read in full; the Wikipedia article confirms attributes + indexing + query interface [25] but not the live-update semantics. If live/reactive intensional groups matter to us (they should — Spotlight smart folders are live [27]), that book chapter is worth a proper read.
- **ISO 25964-1** is paywalled; I relied on the ISO OBP preview, the NISO schema introduction, and secondary summaries [30]. The BTG/BTP/BTI property names and the polyhierarchy statement are well-corroborated, but I have not read the normative clauses.
- **Wikipedia category cycle counts**: the "7 cycles" figure is for the **German** Wikipedia, May 2006 [8]. Numbers for English Wikipedia today are certainly different (and larger). Treat as directional.
- **Nothing found** on a library that *parameterizes* a grouping model by constraints. If such prior art exists, it is not discoverable under the obvious terms. I consider this a real gap in the field, not a search failure — but it is worth one more targeted look before we claim novelty publicly.

---

## 9. KEEP / AVOID — concrete guidance for zodal-groups

### ✅ KEEP

1. **Membership edges are the canonical data. Everything else is a projection.** The thesis survives contact with Unix (hard links [37]), MeSH [4,5], Are.na [19,20], Zotero [15], and SKOS [1]. Build on it.
2. **Store an edge table `(child, parent, kind, …)`. Never a materialized path, never nested sets.** Those cannot represent polyhierarchy [32]. Paths are *derived*.
3. **Edge *kind* is not optional.** Ship `is_a` / `part_of` / `instance_of` / `related` (Z39.19's BTG/BTP/BTI + RT [3]). Closure semantics are a property **of the kind**, not of the system. This is the lesson of SKOS's non-transitive `broader` [1,2] and GO's relation composition [6].
4. **Three distinct concepts, three distinct names**: `assertedEdge` / `closure` (derived) / `collection`-style grouper that is *outside* the hierarchy. SKOS needed all three [1,2]; Z39.19 calls the third a **node label** [3].
5. **Closure is read-time by default; a closure table is a cache, not truth** (OPEN DECISION 1). Preserves provenance, makes re-parenting O(1), matches every standard.
6. **Zotero's `Show Items from Subcollections` is the UX north star** [15]: expose `expand: 'direct' | 'closure'` as a *view* parameter, and let it default per-profile.
7. **De-duplicate ancestors; compute counts over item *sets*, never over paths.** `count(g) = |{i : g ∈ ancestors*(i)}|`. Memoise every traversal. (§4.2)
8. **`primaryParent` for breadcrumbs/URLs** — the honest version of what NN/g says every polyhierarchical site already does [10]. Plus `allPaths()` with a hard cap.
9. **Forbid cycles wherever closure is on; enforce at write time with a path-naming error.** Ship `detectCycles()` + back-edge-deletion repair for imports [8,9].
10. **Ship the qSKOS-derived lint set** (§4.6): `noCycles`, `orphanGroup`, `disconnectedCluster`, `rootHasParent`, `redundantRelated`, `multiParentPartitive`, `assertedInferredEdge`. Every one is empirically motivated [9,3].
11. **Reify the membership edge** (OPEN DECISION 4). Provenance (`assertedBy`), order, kind, and the `(tag, object, identity)` folksonomy triple [12] all need it.
12. **Use Datalog's names**: **extensional** (asserted) vs **intensional** (query-derived) membership; EDB vs IDB [14]. It's precise, citable, and already means the right thing.
13. **Intensional groups are first-class *objects*** — nameable, nestable, taggable — even though their *extent* is derived. This is what `.savedSearch` files get right [27].
14. **Steal the word "profile" and the OWL 2 framing**: *one model, named restrictions, each buying a guarantee* [28]. Steal SHACL's report shape for validation output [29].
15. **Steal Z39.19's ladder as our default profile set**: list → synonym ring → taxonomy → thesaurus [3, §5.4]. It maps 1:1 onto flat tags → tags+aliases → group DAG → typed group DAG.
16. **Empty-result suppression in every browse projection** (Flamenco's core invariant [31,36]).
17. **Design `Member = Item | Group` from day one**, even if the default profile forbids the `Group` case (OPEN DECISION 5). Are.na's channel-as-block is too good to foreclose [19,20].
18. **Offer `"a/b/c"` string sugar — as a *serialization*, compiled to real edges.** Path-as-string is genuinely great DX. It must not be the model.

### ❌ AVOID

1. **Path-as-string as the canonical model.** It structurally forbids polyhierarchy (a tag's parent is its prefix), makes rename O(items), gives you no place to hang edge metadata, and forces closure semantics you can't turn off. Obsidian [16], Bear [17], Gmail labels [21,22] and Logseq [34] all pay this tax; Logseq's namespace-query failure [34] is the visible crack.
2. **Global transitivity.** "Everything is transitive" is how you get *wheel is-a vehicle* — the exact reason SKOS split `broader` from `broaderTransitive` [1,2]. Transitivity is per-edge-kind or it's a bug.
3. **Write-time materialization of implied memberships as the *primary* mechanism.** Danbooru does it and needed three validators plus a "process!" job, and *still* can't cleanly un-apply an implication [23]. Materialize as a cache if you must; never as truth.
4. **Path-derived identity** (MeSH tree numbers, filesystem paths, Gmail label names). MeSH's own docs warn that the descriptor-level shortcut and the tree walk **disagree** [5]. Node identity must be independent of position — ISO 25964's rule: attributes and relationships "are the same wherever it occurs" [30].
5. **Nested sets / materialized path storage.** Disqualified: single-parent by construction, O(n) re-parent [32].
6. **Permitting cycles by default** because "SKOS does" [1]. SKOS is an interchange format under an open-world assumption; we are a UI/data model. For any closure-bearing edge, a cycle is a logical contradiction [9] and a UI hang.
7. **Building on Formal Concept Analysis.** Exponential concept counts [13], unstable lattices, no relation kinds. Use its *implication basis* as an authoring hint; do not use its lattice as the hierarchy.
8. **Counting facets by path.** The most likely correctness bug we will ship. Count over de-duplicated item sets. (§4.2)
9. **A general Datalog/recursive-intension engine in v1** (OPEN DECISION 2). Restrict intensional groups to leaves, error clearly, and revisit.
10. **Conflating facet with group.** A facet is an *axis* ("colour"), a group is a *node on an axis* ("blue"). Z39.19 keeps them apart (facet / node label vs. term [3]); SKOS keeps them apart structurally (Collection ⊥ Concept [1]). Collapsing them means you can never render a facet browser, only a tree.
11. **Two mechanisms for the same thing** (Notion's pages-are-a-tree + relations-are-many-to-many split [35]). One model, many projections — that's the whole pitch.
12. **Unbounded `allPaths()`.** Exponential in DAG depth. Cap it, order it, document it.

---

## REFERENCES

1. W3C. **SKOS Simple Knowledge Organization System Reference** (W3C Recommendation, 18 Aug 2009). [https://www.w3.org/TR/skos-reference/](https://www.w3.org/TR/skos-reference/) — integrity conditions S22, S24, S27, S28–S37; §8.6.6 (`broader` not transitive); §8.6.8 (cycles consistent); Example 38 (polyhierarchy consistent).
2. W3C. **SKOS Simple Knowledge Organization System Primer** (W3C Working Group Note, 18 Aug 2009). [https://www.w3.org/TR/skos-primer/](https://www.w3.org/TR/skos-primer/) — concepts as OWL individuals; rationale for non-transitive `broader`; `skos:Collection` / node labels; polyhierarchy example.
3. NISO. **ANSI/NISO Z39.19-2005 (R2010), Guidelines for the Construction, Format, and Management of Monolingual Controlled Vocabularies.** [https://www.niso.org/publications/ansiniso-z3919-2005-r2010](https://www.niso.org/publications/ansiniso-z3919-2005-r2010) — full text PDF: [https://www.luciehaskins.com/resources/Z39-19-2005.pdf](https://www.luciehaskins.com/resources/Z39-19-2005.pdf). §5.4 (list / synonym ring / taxonomy / thesaurus); §8.3.1 all-and-some test; §8.3.2 instance; §8.3.3 whole-part; **§8.3.3.2 parts of multiple wholes**; **§8.3.4 polyhierarchical relationships**; §8.3.5 node labels; glossary (facet, node label, polyhierarchy, taxonomy, thesaurus, controlled vocabulary).
4. U.S. National Library of Medicine. **MeSH Tree Structures.** [https://www.nlm.nih.gov/mesh/intro_trees.html](https://www.nlm.nih.gov/mesh/intro_trees.html)
5. U.S. HHS / NLM. **MeSH RDF — Tree Numbers.** [https://hhs.github.io/meshrdf/tree-numbers](https://hhs.github.io/meshrdf/tree-numbers) — `meshv:treeNumber`, `meshv:parentTreeNumber`, and the warning that `meshv:broaderDescriptor` traversal disagrees with tree-number traversal.
6. Gene Ontology Consortium. **Ontology Relations.** [https://geneontology.org/docs/ontology-relations/](https://geneontology.org/docs/ontology-relations/) — DAG with multiple parents and different relations per parent; `is_a` / `part_of` / `regulates`; relation composition `is_a ∘ part_of → part_of`.
7. Wikipedia. **Wikipedia:Categorization** (guideline). [https://en.wikipedia.org/wiki/Wikipedia:Categorization](https://en.wikipedia.org/wiki/Wikipedia:Categorization) — cycles "should never form closed loops"; pages should not be in both a category and its subcategory; diffusion.
8. Zesch T, Gurevych I. **Analysis of the Wikipedia Category Graph for NLP Applications.** Proc. TextGraphs-2 Workshop (NAACL-HLT 2007). [https://aclanthology.org/W07-0201/](https://aclanthology.org/W07-0201/) — "cycles and disconnected categories are possible, but rare"; largest connected component = 99.8% of category nodes "as well as 7 cycles"; colored-DFS back-edge deletion to break cycles; edges express "hyponymy or meronymy."
9. Mader C, Haslhofer B, Isaac A. **Finding Quality Issues in SKOS Vocabularies.** TPDL 2012. [https://eprints.cs.univie.ac.at/3444/1/finding_skos_quality_issues.pdf](https://eprints.cs.univie.ac.at/3444/1/finding_skos_quality_issues.pdf) — orphan concepts, weakly connected components, cyclic hierarchical relations, valueless associative relations, solely transitively related concepts, omitted top concepts, top concept having broader concepts; empirical counts across 15–24 vocabularies (DBpedia 1,132 cyclic; MeSH 5). Extended version: **Assessing and Improving the Quality of SKOS Vocabularies**, J. Data Semantics (2013). [https://link.springer.com/article/10.1007/s13740-013-0026-0](https://link.springer.com/article/10.1007/s13740-013-0026-0)
10. Nielsen Norman Group. **Polyhierarchies Improve Findability for Ambiguous IA Categories.** [https://www.nngroup.com/articles/polyhierarchy/](https://www.nngroup.com/articles/polyhierarchy/) — definition; findability argument; the canonical-breadcrumb problem; "use with restraint"; prefer faceted search when overlap is heavy.
11. Hedden H. **Polyhierarchy in Taxonomies.** Hedden Information Management. [https://www.hedden-information.com/polyhierarchy-in-taxonomies/](https://www.hedden-information.com/polyhierarchy-in-taxonomies/) — don't mix relationship types in a polyhierarchy; >2 broader concepts is a design smell; browse UX degradation. See also **Avoiding Mistakes in Taxonomy Hierarchical Relationships**: [http://www.hedden-information.com/avoiding-mistakes-in-taxonomy-hierarchical-relationships/](http://www.hedden-information.com/avoiding-mistakes-in-taxonomy-hierarchical-relationships/)
12. Vander Wal T. **Folksonomy.** [https://www.vanderwal.net/folksonomy.html](https://www.vanderwal.net/folksonomy.html) — the definition, the (tag, object, identity) triple. Broad vs. narrow folksonomy: **Folksonomy Explanations** / Online Information 2005 [https://www.vanderwal.net/essays/051130/folksonomy.pdf](https://www.vanderwal.net/essays/051130/folksonomy.pdf)
13. Wikipedia. **Formal concept analysis.** [https://en.wikipedia.org/wiki/Formal_concept_analysis](https://en.wikipedia.org/wiki/Formal_concept_analysis) — formal context, extent/intent, Galois connection, concept lattice, basic theorem, exponential concept count, Duquenne–Guigues canonical basis.
14. Wikipedia. **Datalog.** [https://en.wikipedia.org/wiki/Datalog](https://en.wikipedia.org/wiki/Datalog) — extensional database (EDB) vs. intensional database (IDB); transitive closure as the prototypical program; naive/semi-naive bottom-up evaluation (materialization) vs. top-down SLD (on-demand); stratified negation.
15. Zotero. **Collections and Tags.** [https://www.zotero.org/support/collections_and_tags](https://www.zotero.org/support/collections_and_tags) — items in multiple collections without duplication; "collections are like playlists"; flat tags; saved searches; **View → Show Items from Subcollections**; tags portable, collections not.
16. Obsidian. **Tags** (official help). [https://obsidian.md/help/tags](https://obsidian.md/help/tags) — nested tags via `/`; "`tag:inbox` will match `#inbox` as well as all nested tags such as `#inbox/to-read`".
17. Bear. **How to Make Nested Tags.** [https://bear.app/faq/nested-tags/](https://bear.app/faq/nested-tags/) — `/` creates parent/child; unlimited depth.
18. Tana. **Supertags.** [https://outliner.tana.inc/learn/features/supertags](https://outliner.tana.inc/learn/features/supertags) and **When to use Extend in supertags** [https://tana.inc/articles/when-to-use-extend-in-supertags](https://tana.inc/articles/when-to-use-extend-in-supertags) — supertag `extend` = single-parent inheritance of fields; multiple supertags per node; searching a parent tag returns descendants.
19. Are.na. **Channels** and **Connections** (help). [https://help.are.na/docs/getting-started/channels](https://help.are.na/docs/getting-started/channels) · [https://help.are.na/docs/getting-started/connections](https://help.are.na/docs/getting-started/connections) — a block can be connected to an infinite number of channels; a channel can be put into another channel and "act as a block"; "This channel appears in".
20. Are.na. **API — Blocks.** [https://dev.are.na/documentation/blocks](https://dev.are.na/documentation/blocks) — the `connections` attribute lists the channels a block appears in.
21. Google. **Gmail API — `users.labels` reference.** [https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels) — the `Label` resource has `id`, `name`, `type`, visibility, counts, color; **no parent field**.
22. Google. **Gmail API — Managing labels.** [https://developers.google.com/workspace/gmail/api/guides/labels](https://developers.google.com/workspace/gmail/api/guides/labels) — labels have "a many-to-many relationship with messages and threads"; nesting is expressed in the `name` string (`Parent/Child`), which is a single label.
23. Danbooru — **Tag Relationships** (TagAlias / TagImplication), DeepWiki analysis of the danbooru/danbooru codebase. [https://deepwiki.com/danbooru/danbooru/4.1-tag-system](https://deepwiki.com/danbooru/danbooru/4.1-tag-system) — `TagImplication#process!` materializes the consequent tag onto all matching posts at approval; circular relations rejected; transitive chains `A→B→C` rejected; retired/deleted statuses.
24. DEVONtechnologies. **How to Use Duplicates and Replicants.** [https://www.devontechnologies.com/blog/20230524-duplicates-replicants](https://www.devontechnologies.com/blog/20230524-duplicates-replicants) — a replicant is a clone with no original; used to file an item in multiple groups; cannot replicate twice into the same group.
25. Wikipedia. **Be File System.** [https://en.wikipedia.org/wiki/Be_File_System](https://en.wikipedia.org/wiki/Be_File_System) — extended attributes with indexing and querying "to provide functionality similar to that of a relational database."
26. Giampaolo D. **Practical File System Design with the Be File System.** Morgan Kaufmann, 1999. [http://www.nobius.org/dbg/practical-file-system-design.pdf](http://www.nobius.org/dbg/practical-file-system-design.pdf) — attributes, attribute indices, query language, live queries.
27. Oakley H. **How to search successfully in Spotlight: Saved Search.** The Eclectic Light Company, 2025. [https://eclecticlight.co/2025/06/03/how-to-search-successfully-in-spotlight-saved-search/](https://eclecticlight.co/2025/06/03/how-to-search-successfully-in-spotlight-saved-search/) — a Smart Folder is a `.savedSearch` XML file holding a Spotlight predicate; results are dynamic; the file is portable.
28. W3C. **OWL 2 Web Ontology Language Profiles (Second Edition).** [https://www.w3.org/TR/owl2-profiles/](https://www.w3.org/TR/owl2-profiles/) — EL / QL / RL as syntactic subsets trading expressivity for tractability.
29. W3C. **Shapes Constraint Language (SHACL)** (W3C Recommendation, 2017). [https://www.w3.org/TR/shacl/](https://www.w3.org/TR/shacl/) — node/property shapes, `sh:path`, `sh:minCount` / `sh:maxCount`, `sh:class`, `sh:in`, `sh:closed`, validation reports.
30. ISO. **ISO 25964-1:2011 — Thesauri and interoperability with other vocabularies — Part 1: Thesauri for information retrieval.** [https://www.iso.org/obp/ui/en/#!iso:std:53657:en](https://www.iso.org/obp/ui/en/#!iso:std:53657:en) · NISO schema introduction: [https://www.niso.org/schemas/iso25964/schema-intro](https://www.niso.org/schemas/iso25964/schema-intro) — `broaderGeneric` / `broaderPartitive` / `broaderInstantial`; `ThesaurusArray`, `ConceptGroup`; polyhierarchy with node identity preserved across positions.
31. Hearst M. **Design Recommendations for Hierarchical Faceted Search Interfaces.** ACM SIGIR Workshop on Faceted Search, 2006. [https://flamenco.berkeley.edu/papers/faceted-workshop06.pdf](https://flamenco.berkeley.edu/papers/faceted-workshop06.pdf)
32. Karwin B. **Rendering Trees with Closure Tables** / **SQL Antipatterns** (Ch. "Naive Trees"). [https://karwin.com/blog/index.php/2010/03/24/rendering-trees-with-closure-tables/](https://karwin.com/blog/index.php/2010/03/24/rendering-trees-with-closure-tables/) — adjacency list vs. path enumeration vs. nested sets vs. closure table; "a DAG is a more general version of a closure table."
33. Wikipedia. **C3 linearization.** [https://en.wikipedia.org/wiki/C3_linearization](https://en.wikipedia.org/wiki/C3_linearization) — the deterministic, monotonic MRO used by Python (since 2.3) and originally published for Dylan; the standard resolution of the diamond problem. Python's own account: [https://docs.python.org/3/howto/mro.html](https://docs.python.org/3/howto/mro.html)
34. Logseq forum. **Namespace query: retrieve lower levels in the namespace hierarchy.** [https://discuss.logseq.com/t/namespace-query-retrieve-lower-levels-in-the-namespace-hierarchy/8148](https://discuss.logseq.com/t/namespace-query-retrieve-lower-levels-in-the-namespace-hierarchy/8148) — namespace queries do not traverse lower levels.
35. Notion. **Relations & rollups.** [https://www.notion.com/help/relations-and-rollups](https://www.notion.com/help/relations-and-rollups) — relation properties can be limited to 1 page or unlimited (many-to-many).
36. Hearst M. **Faceted Metadata in Search Interfaces** (AAAI-05 invited talk). [https://cdn.aaai.org/AAAI/2005/IT05-004.pdf](https://cdn.aaai.org/AAAI/2005/IT05-004.pdf) — Flamenco design goals: flexible navigation, integration of browse and search, fluid refine/expand, **avoidance of empty result sets**.
37. **Why are hard links to directories not allowed in UNIX/Linux?** Unix & Linux Stack Exchange. [https://unix.stackexchange.com/questions/22394/why-are-hard-links-to-directories-not-allowed-in-unix-linux](https://unix.stackexchange.com/questions/22394/why-are-hard-links-to-directories-not-allowed-in-unix-linux) — cycles, `fsck` / tree-walker safety, and reference-counting GC as the reasons directories are restricted to a single parent while regular files are not. Corroborating course notes: [https://teaching.idallen.com/cst8207/19w/notes/455_links_and_inodes.html](https://teaching.idallen.com/cst8207/19w/notes/455_links_and_inodes.html)
38. Britannica. **Colon Classification.** [https://www.britannica.com/science/Colon-Classification](https://www.britannica.com/science/Colon-Classification) — Ranganathan; the first faceted classification.
39. Glushko R (ed.). **Faceted Classification**, in *The Discipline of Organizing* (4th Professional Edition). [https://berkeley.pressbooks.pub/tdo4p/chapter/faceted-classification/](https://berkeley.pressbooks.pub/tdo4p/chapter/faceted-classification/) — facet analysis, citation order, enumerative vs. analytico-synthetic.
40. Grossmann S, et al. **Improved detection of overrepresentation of Gene-Ontology annotations with parent–child analysis.** *Bioinformatics* 23(22):3024–31, 2007. [https://doi.org/10.1093/bioinformatics/btm440](https://doi.org/10.1093/bioinformatics/btm440) — the true-path rule stated operationally ("whenever a gene is annotated to a term it is also implicitly associated with all the less specific parents of that term").
