# zodal-groups Research 03 — Navigation & UX Patterns for Hierarchies, and What Breaks in a Polyhierarchy

**Scope.** How people view, navigate, and search hierarchies; the standard vocabulary for each pattern; and — the heart of this report — what specifically changes when the structure is a DAG (items in many groups, groups with many parents) rather than a tree.

**Framing commitment (given).** The membership relation is canonical; every tree/browser/tag-cloud is a *computed projection* over it. The presentation gesture is not in the model. Everything below is evaluated against that commitment.

**Convention.** Cited facts carry [n]. My own design opinions are marked **[SYNTHESIS]**.

---

## 0. Executive summary

Six findings drive the recommendations:

1. **Polyhierarchy demonstrably improves findability**, and users like navigating multiple hierarchies. NN/g finds a polyhierarchical IA "accommodates diverse user mental models" [9]; Hearst's Flamenco usability work found "a strong majority of participants preferred being allowed to navigate in multiple hierarchies; they felt they were in control and did not feel lost" [10].

2. **But the single biggest deployed multi-parent file system on earth deleted the feature.** Google Drive removed multi-parenting on 2020-09-30 — "it is no longer possible to place an item in multiple folders; every item has exactly one location" — and migrated the extra parents into **shortcuts** [28][29]. This is the strongest empirical signal in the whole report and it is a signal about *presentation*, not about the model: a *tree of shortcut-nodes* was judged more teachable than a *DAG of items*.

3. **The breadcrumb is where polyhierarchy hurts most.** NN/g is explicit: for multi-parent pages "identify a canonical path… and show that path… Don't attempt to personalize the breadcrumb trail" [8][9]. Hearst's alternative is to abandon the single trail entirely and keep "the path within each facet in a separate visual component" [10].

4. **The classic tree-state bug is real and has a precise formulation:** expansion/selection state keyed by **node id** makes a duplicated node expand in all its places at once; keyed by **path** it expands independently. Both are defensible; the bug is *not choosing* [tree-library survey, §B.3].

5. **Accessibility forces a tree.** `aria-owns` explicitly forbids multiple owners — "Make sure your owned elements have only one owner. Do not specify the id of an element in more than one other element's `aria-owns` attribute" [4]. The accessibility tree *is a tree*. A DAG model must therefore be **unfolded into path-nodes** before it hits the DOM.

6. **Counts double-count by default.** Solr's documented behaviour for a multivalued field: "a document with two dates… will be counted in each bucket" [15]. Every ancestor count in a DAG needs an explicit `distinct` decision, and the UI must say which one it made.

---

# PART A — The catalog of navigation designs (standard terminology)

## A.1 Tree view / outline / disclosure tree (expand-in-place)

**What it is.** A widget that "displays a hierarchical list where items may contain child items that can be expanded or collapsed" [1]. In ARIA terms: `role="tree"` container, `role="treeitem"` nodes, `role="group"` for child collections [1][3].

**Standard keyboard contract** (APG) [1]:
- Down/Up: move among *visible* nodes (the flattened visible list, not the logical tree)
- Right: expand a closed node, else move to first child
- Left: collapse an open node, else move to parent
- Home/End: first/last visible node
- Enter: activate
- **Type-ahead**: "focus moves to the next node with a name that starts with the typed character" — the APG calls this "highly recommended" for trees with more than ~7 root nodes [1]
- Multi-select: Space toggles, Shift+Arrow extends, Ctrl+A selects all; requires `aria-multiselectable="true"` [1]

**Required/expected ARIA** [1][3]: `aria-expanded` (only on parent nodes — putting it on leaves misrepresents them as parents [2]), `aria-selected`/`aria-checked`, `aria-label`/`aria-labelledby` on the container. `aria-level`, `aria-posinset`, `aria-setsize` are *optional when the DOM nesting expresses the hierarchy* and **required when it does not** — i.e. required the moment you virtualize [1] (see §D.2).

**The APG's own escape hatch:** "Correct implementation of the tree role requires implementation of complex functionality that is not needed for typical site navigation, and a pattern more suited for typical site navigation with expandable groups of links is the **disclosure** pattern" [1]. Many "trees" should be nested disclosures.

**When it wins.** Deep, stable, frequently-revisited structures; when you want *simultaneous* visibility of several branches; when the user is manipulating (drag/rename) rather than merely reading.

**How it degrades.** Expansion state explodes; the visible list length is unbounded; horizontal indentation eats width at depth; and — critically — **it has no native answer to "this node is also over there."**

**Treegrid** [2] is the tree-with-columns variant: `role="treegrid"`, `role="row"` with `aria-expanded` on the row (or a cell in it), cells are `gridcell`/`rowheader`. Both rows and cells are focusable; use it when nodes carry tabular metadata you must show and edit inline. It is strictly more expensive to implement than `tree`.

## A.2 Miller columns (cascading lists / column view)

**What it is.** Adjacent columns, one per level; selecting an item in column *n* populates column *n+1* with its children [5]. "Also called cascading lists."

**Origin (get this right).** "Independently invented by **Mark S. Miller in 1980 at Yale University**," related to but independent of the Smalltalk browser; used at **Project Xanadu, Datapoint, and NeXT**; macOS Finder's Columns view "descend[s] directly from the NeXTSTEP File Viewer's use of Miller columns going back to 1986" [5]. (Not Ranganathan — that's faceted *classification*, a different lineage; see A.5.)

**The DAG fact that matters to us:** "**While at Datapoint, Miller generalized the technique to browse directed graphs with labeled nodes and arcs**" [5]. The inventor of the pattern already extended it past trees. This is the single most encouraging precedent in the report.

**Modern uses.** macOS Finder column view; iTunes "Browser"; `ranger`; GWorkspace; Pantheon Files [5]. And notably **GOV.UK's `miller-columns-element`**, built for *hierarchical topic selection during content tagging* — i.e. Miller columns used as a **picker into a taxonomy**, not as a file browser, with a companion `<miller-columns-selected>` element rendering the chosen items as a separate list [6]. (The repo is retired/absorbed into Whitehall [6].)

**When it wins.** High branching factor / wide-and-shallow; you want to see siblings-at-every-level simultaneously; rapid lateral re-scanning ("wrong folder, try the next one") without collapsing anything.

**How it degrades.** Documented limitations [5]: deep navigation forces horizontal scrolling; columns get narrow; "sort options and metadata display are limited." Wikipedia's own summary: best "for structures with high branching factor; for simpler hierarchies, outline editors or graph viewers prove more effective" [5].

**[SYNTHESIS]** Miller columns are *the* most polyhierarchy-tolerant classic browser, because **the column stack IS the path**. You arrived by a path, the path is on screen, and the same node reached by a different path simply produces a different column stack. Expansion state is *inherently path-keyed* (§B.3) — the bug class disappears by construction. This is a strong argument to make Miller columns a first-class projection in zodal-groups, not an afterthought.

## A.3 Drill-down (one level at a time) + breadcrumb return path

**What it is.** The Finder/Explorer icon-or-list view: double-click to *enter* a group, the view replaces itself. Zero simultaneous context; all context is carried by the breadcrumb / path bar / Back button.

**When it wins.** Mobile and small viewports; touch; novice users; very large sibling sets (you get the full width for one level).

**How it degrades.** No cross-branch comparison. Every lateral move is up-then-down. Information scent (§A.8) must be entirely carried by the folder labels, because you can't peek.

**[SYNTHESIS]** Under polyhierarchy drill-down is *fine* — arguably the safest of all the tree patterns — precisely because it only ever shows **one** path at a time, and the path it shows is the one you actually walked. It naturally implements "trail memory" (§B.2) with no extra design.

## A.4 Breadcrumbs — the three types (this distinction is load-bearing for us)

Keith Instone's taxonomy (IA Summit 2002/2003) is the standard vocabulary [7]:

| Type | Definition [7] | Answers |
|---|---|---|
| **Location** | "show the single location of a page within a site" — position in the IA, *irrespective of how you got there* | "Where am I?" |
| **Path** | "show the particular path the user has taken within the site to the page" — session history | "How did I get here?" |
| **Attribute** | "meta-information within the site… represented in a breadcrumb-like fashion" — the attributes/facets selected; "many different trails representing several possible paths" | "What am I filtering by?" |

**NN/g's position:** use **location** breadcrumbs, not path breadcrumbs; breadcrumbs "should show the site hierarchy, not the user's history" [8]. And explicitly on our problem: for a page with more than one parent, "identify a **canonical path** to it in the site hierarchy and show that path… Don't attempt to personalize the breadcrumb trail" — NN/g "explicitly advises *against* showing multiple breadcrumb trails" [8].

Other NN/g guidelines worth keeping: breadcrumbs never replace global/local nav; include the current page as the last, non-clickable item; don't invent abstract categories that aren't real pages; skip breadcrumbs entirely for 1–2-level structures [8].

**[SYNTHESIS] — the key reframe.** Instone's **attribute** breadcrumb is *the polyhierarchy-native breadcrumb*, and it is what Hearst's faceted breadcrumb actually is [10]. A location breadcrumb presupposes "the" location. An attribute breadcrumb presupposes only "these constraints." zodal-groups should model breadcrumbs as **three distinct projections over the same membership relation** — `locationTrail(node, {policy})`, `pathTrail(navigationHistory)`, `attributeTrail(activeFilters)` — and let the app pick. Do not bake "breadcrumb" in as a single concept.

## A.5 Faceted search / faceted browsing

**Lineage.** Faceted *classification* is Ranganathan (colon classification). Faceted *search UI* as we know it is Hearst's **Flamenco** project at Berkeley [10][11]; "interfaces similar in design to Flamenco are now the standard on e-commerce sites, image navigation sites, and library catalog sites."

**Hearst's terminology** [10]: a **facet** is a dimension (Cuisine, Ingredient); each facet has **labels**; facets may be *flat* or *hierarchical*; labels beneath a label are its **subhierarchy**.

**The semantics — memorize this sentence** [10]:
> "Selecting a label within a hierarchy is equivalent to performing a **disjunction over all the labels beneath it**. When labels from different parts of the interface are selected, the system in effect builds a query that is a **conjunct of disjuncts** over the selected labels and their subcategories."

That is the formal statement of within-facet-OR / across-facet-AND (§C.3), *plus* the descendant-rollup rule (§C.1), in one line. It is exactly the semantics zodal-groups needs.

**Hearst's design recommendations, distilled** [10]:
- **Step-by-step drill-down** beat both the fly-away-menu approach (obscures the display, hard to multi-select, and "precludes progressive disclosure of hierarchy") and the Explorer-style expand-many-branches tree.
- **The Explorer critique is aimed directly at us:** an Explorer-like folder tree has "two major downsides. First, if many of the hierarchies are expanded, the navigation component can get very large and require extensive scrolling. Second, and more importantly, **users would be unfamiliar with the idea of an item simultaneously residing in multiple folders, since Explorer does not support that functionality**" [10]. Hearst is saying, in 2006: *do not teach polyhierarchy through a folder-tree metaphor.*
- **Query previews (counts) next to every label**, so users never drill into an empty set. But note the cost: "query previews must be computed for every level of the hierarchy" [10].
- **Never hide a facet that has gone empty** — grey it out; "numerous usability results indicate the importance of retaining consistency in availability of selections" [10].
- **Keep the path within each facet in a separate visual component.** "This both reinforces the notion of the query consisting of a conjunction of different categories at different levels of hierarchy, and allows for flexible expansion of the query, since the user can eliminate an entire term by clicking on the iconic X… or expand up within a category by clicking on a parent term" [10]. eBay Express went further and split a hierarchical facet into two pieces in the query display.
- Facet label ordering: predictable (alphabetical/numeric) is generally preferred; frequency-ordering is useful only when showing a few of many [10].
- Keyword search must be *absorbed into the facet breadcrumb* as just another removable term [10]. ("Search within results" remains an unsolved wart even in Flamenco: "The Flamenco design does not solve this problem satisfactorily" [10].)

**Empirical support.** Flamenco users preferred the faceted design on "easy to use," "easy to browse," "flexible," "enjoyable" [11]. Categorized overviews beat flat lists: participants "delved deeper into the results list when they used the grouping interface," and hand-built category systems beat automatic clusters and flat lists [11][45][46].

**[SYNTHESIS]** Faceted browsing is **the only mainstream pattern that is natively polyhierarchical** — it never claims an item has one home; it says an item has many labels. If zodal-groups gets one projection perfect, make it this one.

## A.6 Tag clouds, tag pickers, typeahead tag input

**Tag cloud.** Weighted list of labels, font size ∝ frequency. Hearst & Rosner's verdict is unkind: tag clouds function largely as a **social signal** — "tag clouds are meant to show that there are people actively using the information… they signal that people are talking"; interviewees valued them as "fun and hip." On task performance, participants "performed higher on a descriptive task with the tag cloud interface but were **less accurate on a relational task and were overall slower**" [12].

**[SYNTHESIS]** Ship tag clouds as a *gestalt/entry* projection (what is this collection about?), never as the primary navigation. Do not compute them from expensive queries.

**Tag picker / typeahead tag input.** The workhorse. Combobox + chips. Under polyhierarchy this is *the* editor for the membership relation: it is the only widget whose affordance is literally "this item has a set of groups." Note the ARIA cost: it's a `combobox` + `listbox`, not a `tree`.

**Hierarchical tag picker.** Two viable forms: (a) nested-tag *strings* with a path separator — Obsidian's `#blogwriting/editing`, where `tag:#blogwriting` matches the whole subtree [Obsidian nested tags, 58]; (b) a Miller-columns or tree *picker* that emits a set of leaf ids — GOV.UK's `miller-columns-element` [6]. Form (a) is cheap and searchable but silently *re-imposes single-parenthood on the tag itself* (a tag has one path). Form (b) survives polyhierarchy.

**[SYNTHESIS]** Do not use path-string tags as the canonical encoding. They are a **rendering** of a tree projection, not a model. (This is the same mistake as encoding the presentation gesture in the model.)

## A.7 Space-filling: treemap / sunburst / icicle

**What they are.** Area/angle/length-encoded, 100%-of-parent decompositions of a hierarchy.

**When they actually work — the honest read of the evidence.** A controlled comparison found the **treemap was the least preferred** and slower on basic navigation and hierarchy-understanding tasks, while **icicle plots and sundown charts performed similarly with a slight preference for the icicle** [52]. Bamberg's synthesis: for *large* hierarchies sunburst and circular treemaps performed best; for *small* ones treemap/icicle/circular treemap [53]. Perceptually, icicle is the strongest encoding (length on a common baseline — the top of Cleveland & McGill's accuracy ranking); treemap uses area; sunburst forces users to integrate angle *and* radius, which is "cognitively demanding and error-prone" [53].

**They are for one job: "where did all the space/count/cost go?"** (DaisyDisk, WinDirStat, flame graphs.) They are eye candy for *navigation*.

**Polyhierarchy verdict.** Space-filling visualizations are **fundamentally incompatible** with a DAG without a lie: they require that children's measures **partition** the parent's. In a DAG an item under two children double-counts and the rectangle/wedge overflows 100%. You must either (a) unfold to a tree of paths and accept that the total exceeds the true item count, or (b) apportion fractional weight (1/k to each of k parents), which is defensible for *cost* but nonsense for *count*.

**[SYNTHESIS]** Support **icicle** as the space-filling projection (best encoding, cheapest layout, natural fit to a flattened row model that you already need for virtualization). Refuse treemap/sunburst until someone asks. And require an explicit `weight` strategy — never silently double-count into a space-filling chart.

## A.8 Search-first / query-as-navigation

**Lineage.** Malone's 1983 desk study split knowledge workers into **filers** and **pilers**, and observed that a key function of the desk is *reminding*, not just retrieval — "failing to support this function may seriously impair the usefulness of electronic office systems" [19]. This is the origin of the "piles vs. files" framing. **Information Foraging Theory** (Pirolli & Card, PARC, 1999) supplies the mechanism: users maximize information-value-per-unit-cost, and navigate by **information scent** — "the imperfect perception of the value, cost, or access path of information sources obtained from proximal cues" [17][18][47]. Users abandon a patch when perceived value drops below effort [18].

**The products.** BeOS live queries (saved queries in a filesystem, mid-90s) → Dominic Giampaolo → **macOS Spotlight + Smart Folders**, where a saved search is a `.savedSearch` plist that "doesn't list the files 'contained' by this 'folder', but instead gives the **search predicate**" [44]. Gmail: retrieval is search-first, folders are labels [30]. Outlook **Search Folders** [48]. iTunes smart playlists with "live updating" [44].

**[SYNTHESIS]** Search-first is the pattern that *does not care* whether the structure is a tree or a DAG — the query is a predicate over the membership relation, and predicates compose. It is therefore the **safest fallback projection** and should be available everywhere (§C).

## A.9 Split-pane master–detail, virtualized lists, lazy children

- **Master–detail**: group tree/list on the left, item list in the middle, item detail on the right. The Zotero/Mail/Finder shape. This is where "what other groups is this item in?" naturally lives — Zotero 7 literally added a **Collections section in the item pane** [24].
- **Virtualized long lists**: mandatory past a few thousand rows. Standard approach = **flatten the currently-visible nodes into a row array and window it**; MUI X forces `domStructure: "flat"` when virtualization is on, and it "cannot be changed" [40]. Consequences in §D.2.
- **Lazy/async children**: the group node reports "has children" without knowing them. Requires a tri-state: `unknown | loading | loaded`. ARIA: `aria-expanded="false"` + a busy state; the APG notes `aria-level`/`posinset`/`setsize` become **required** with dynamic loading [1].

## A.10 Node-link graph view of the group DAG itself

When the *taxonomy* is the artifact being edited (not the items), the node-link graph becomes the right view: PoolParty's concept-map visualization of a SKOS thesaurus [taxonomy tooling, 38 context]; Protégé's OntoGraf / OWLViz with expand/collapse of nodes.

**[SYNTHESIS]** This is a *distinct audience* (taxonomist, not end-user) and a distinct projection. Provide `groupGraph()` returning nodes+edges and let a graph library render it. Do not try to make it the browsing UI; Wikipedia's category graph — 1.16M categories, multiple parents, and *actual cycles* like Space → Geometry → Geometric measurement → Dimension → Space [54, cycle analysis] — is the cautionary tale for what "just show the graph" produces at scale.

---

# PART B — What is genuinely different in a polyhierarchy

## B.0 The prior art is thin, and one giant walked it back

Two academic anchors exist, both by Perugini:

- **"Symbolic links in the Open Directory Project"** (IP&M 2008) [36]. Models a web directory as a graph where **hard links** create "the natural parent–child relationships within a hierarchy" and a **symbolic link** is "a special hyperlink whose target vertex is the target of an existing hard link" [37]. Empirical findings on the ODP (then the largest human-compiled taxonomy): **~97% of symbolic links result in multiclassification**, and **>77% connect categories that share at least their first two levels** of topic specificity. Crucially: symbolic links used as backlinks or for multiclassification, "**by inducing cycles, preclude the underlying graph model of the directory from being a DAG**" [36].
- **"Supporting multiple paths to objects in information hierarchies: Faceted classification, faceted search, and symbolic links"** (IP&M 2010) [37]. Names exactly three ways to give an object multiple access paths: **faceted classification**, **faceted search**, and **hierarchy + symbolic links**.

And the industrial anchor: **Google Drive abolished multi-parenting.** As of 2020-09-30 "it is no longer possible to place an item in multiple folders; **every item has exactly one location**"; existing multi-parented items were migrated so that "any other parent-child relationships [became] **shortcuts** in the former parent folders"; the API gained `enforceSingleParent`, and `files.create`/`files.copy` can no longer specify multiple parents [28][29].

**[SYNTHESIS] — read this correctly.** Google did not conclude that multi-membership is wrong. They concluded that a **first-class item with N parents** is unteachable, and that **one canonical home + N explicit shortcut objects** is teachable. The information content is identical; the *projection* is different: a shortcut is a **materialized path-node** that the user can see, name, move, and delete independently. That's the same trick Miller columns pull implicitly and the same trick DEVONthink's replicants pull explicitly.

Three deployed strategies for the same underlying DAG, then:

| Strategy | Model | User-visible object | Example |
|---|---|---|---|
| **Symmetric multi-parent** | item ↔ many groups, no primary | the item, listed in N places | Gmail labels [30], Are.na connections [26], Zotero collections [23], DEVONthink replicants [22] |
| **Canonical + links** | one primary parent + N link objects | the item *and* N shortcut/alias objects | Google Drive shortcuts [28][29], ODP symbolic links [36], Unix symlinks, macOS aliases [35] |
| **Facets** | item ↔ many labels across dimensions | no "location" at all | Flamenco / e-commerce [10][11] |

zodal-groups' canonical relation supports all three; the **strategy is a projection/policy choice**, and the library should name it as such.

## B.1 "What other groups is this item in?" — the reverse-membership affordance

Meaningless in a tree (answer: one). **Essential** in a DAG. There is **no settled name for this UI**, which is itself a finding. The deployed vocabulary:

| Product | The affordance | Name |
|---|---|---|
| **Zotero** | Select an item, **hold Option/Ctrl/Alt** → every collection containing it **highlights in yellow** in the left pane; "multiple collection names should turn yellow" if it's in several. Zotero 7 also added a persistent **"Collections" section in the item pane** listing them [24][23] | (unnamed; "collections containing an item") |
| **Gmail** | **Label chips rendered on the message itself**, each with an **`×`** to remove *that* membership [30] | "labels" |
| **Are.na** | A block's **`connections`** — "any block can be reused in multiple channels (this is called a **connection**)"; "blocks can be connected to an **infinite number of channels**," and the block page lists the channels it appears in (filtered by the viewer's access) [26][27] | **"Connections"** |
| **DEVONthink** | **Replicants** — "not a copy but a clone… all replicants are just instances of one item"; used precisely "when you want to file something in multiple locations." Constraints: same database only; **cannot replicate into the same group twice** [22] | **"Replicants"** |
| **macOS Finder** | **"Reveal in enclosing folder"** — singular by construction; "All My Files"/Recents is the tree-less fallback | "Reveal" |
| **MeSH** | Each descriptor carries **multiple tree numbers**; the Browser shows the primary number "followed by one or more additional numbers, in smaller type and truncated at the third level, indicating **other tree locations of the same term**" [20][21] | **"Tree numbers"** |

**[SYNTHESIS] Name it, and make it the default item affordance.** I recommend the Are.na noun — **"connections"** — or the neutral **"memberships."** Concretely:
- Every item detail view gets a `Memberships` section: chips, each removable, each click-to-navigate.
- Every *tree/browser* view gets a **"highlight all locations"** modifier-key behaviour (Zotero's is the best in class and is worth copying gesture-for-gesture: it costs nothing at rest and answers the question instantly).
- Reverse-membership **must be a first-class query on the provider** — `getGroupsOf(itemId)`. If a store adapter can't answer it cheaply, it can't back a polyhierarchy UI. Put it in the capabilities contract.

## B.2 Multi-path breadcrumbs — the hardest problem in the report

The item/group is reachable via several paths. Four options, all with real costs:

**Option 1 — Canonical path.** Pick one; always show it. This is NN/g's official recommendation [8][9] and Google Drive's post-2020 model [28]. *Cost:* NN/g names the exact failure — a polyhierarchy "creates a fundamental conflict with breadcrumb navigation. Since pages can't show multiple paths simultaneously, systems must display a canonical path, **which may contradict how users actually navigated there**" [9]. The user clicked *Electronics → Nintendo Switch* and the breadcrumb says *Video Games*. That is a trust-destroying moment.

**Option 2 — Trail memory (path breadcrumb / "the way you came").** Show the path actually walked. This is Instone's **path** breadcrumb [7]. It is what Miller columns and drill-down do *for free*. *Cost:* NN/g's objection — breadcrumbs "should show the site hierarchy, not the user's browsing history" [8] — plus: it's unstable across deep-links, bookmarks, refresh, and shares; and if the user arrived by search there *is* no trail.

**Option 3 — Show all paths.** MeSH does this (multiple tree numbers, secondary ones truncated to 3 levels [20][21]); Wikipedia does this (an article's category box lists every category it's in). *Cost:* combinatorial. In a DAG the number of root-to-node paths is exponential in depth. Truncation (MeSH's "truncated at the third level") is not a nicety — it is the only thing that makes it renderable.

**Option 4 — Attribute breadcrumb / no path at all.** Hearst: don't show "the" path, show the *conjunction of active constraints*, each removable, each generalizable by clicking a parent term; keep each facet's trail in its own visual component [10]. *Cost:* it doesn't answer "where am I in the taxonomy," because it denies the question.

**[SYNTHESIS] — the design I'd actually ship.**

> **The breadcrumb is a function of (node, navigation-context, policy) — not a property of the node.**

```
breadcrumb(node, { context, policy })
  policy: 'arrival'    // path breadcrumb — use the trail the user walked (Miller/drill-down)
        | 'canonical'  // location breadcrumb — resolve via a total order on parents
        | 'all'        // multi-path — render N trails, truncated, secondary ones de-emphasized
        | 'attribute'  // faceted — the active constraint set, not a path
```
Default **`'arrival'` when a trail exists, falling back to `'canonical'`** — this is the least-surprising combination and is exactly what Miller columns give you for free. Crucially, **when the arrival path is not the canonical path, say so**: render the canonical path as a secondary, muted trail with an affordance ("also in *Video Games*"). This dissolves NN/g's objection: the contradiction is only harmful when it is *silent*.

The canonical-path resolver must be **injectable policy**, never hardcoded. Sensible built-ins: `firstAdded`, `explicitPrimary` (a `primaryParent` flag on the edge), `shortestPath`, `mostSpecific`, `lexicographic`. Note that a `primaryParent` flag on the membership edge is *exactly* Google's shortcut model expressed in the relation, and it costs one boolean.

## B.3 The same node in two places in one tree — expansion & selection state identity

**This is the classic bug.** Group *G* appears under both *A* and *B*. The user expands *G* under *A*. What happens under *B*?

The libraries have quietly already answered — with the ID/path split. React's own guidance ("keep ID or index in state, not the object itself") plus tree-library practice: **"Row keys are not always unique, so it is recommended to instead use the node ID *or data path* to identify the row"**, and the consequence is explicit — "**using path-based tracking will treat them as separate nodes, while using node IDs will share expansion state across all instances**" [tree-state survey, 40 + React docs].

So:

| State key | Behaviour | Feels right for |
|---|---|---|
| **Node id** | Expand under *A* → also expands under *B*. Select once → selected everywhere. "It is one thing." | **Selection**, checked-state, focus-follows-item, "highlight all locations" (Zotero's yellow) |
| **Path** (`A/G`, `B/G`) | Expand under *A* → *B* stays collapsed. Two independent rows. | **Expansion**, scroll position, per-row UI, virtualization keys, DOM/ARIA identity |

**[SYNTHESIS] The right answer is: BOTH, split by concern — and this is not a compromise, it's the correct decomposition.**

> **Expansion is a property of the *rendered path-node*. Selection is a property of the *item*.**

Rationale: expansion is a *view* fact ("I opened this drawer"), and there genuinely are two drawers. Selection is a *model* fact ("I have chosen this thing"), and there genuinely is one thing. If you key selection by path you will get the horrible bug where the user selects `A/G`, deletes it, and `B/G` is still highlighted pointing at a dead item. If you key expansion by node id you will get the equally horrible bug where opening one branch spontaneously reflows a distant branch off-screen.

Implementation consequence: the tree projection must emit **path-nodes**, not nodes:
```ts
type PathNode = {
  nodeId: GroupId;          // model identity  → selection, membership ops, "other locations"
  pathKey: string;          // view identity   → expansion, DOM key, virtualization, aria
  path: GroupId[];          // the ancestry that produced this rendering
  depth: number;            // → aria-level
  isRecursive: boolean;     // this nodeId already appears in `path` — cycle guard, render as leaf
};
```
`pathKey` is the join of `path` (e.g. `"root/A/G"`). Emit this from the projection layer once; every renderer (tree, treegrid, icicle, virtualized list) consumes it.

Two more required behaviours:
- **Cross-highlighting.** Because you kept `nodeId`, hovering/selecting one path-node can subtly highlight *all* path-nodes with the same `nodeId`. This is the cheapest possible teaching device for "this is the same thing in two places" — and it is the affordance that the folder metaphor lacks (Hearst's complaint [10]).
- **Recursion/cycle guard.** `isRecursive` is not optional. The ODP data shows real taxonomies **do contain cycles** [36], and Wikipedia's category graph certainly does [54]. The projection must terminate: if `nodeId ∈ path`, render it as a non-expandable leaf with a "↻ already shown above" marker.

## B.4 Removing vs. deleting — and the orphan problem

**The distinction is universal and every serious product makes it:**

- **Gmail:** removing a label "only removes the label from that specific message"; other labels survive. Deleting removes the message "from every label." And the key detail: **"If you 'delete' all labels from a message you still have not actually deleted the message. It still resides in a label/group in Gmail called All Mail"** [30]. Gmail has an **implicit universal group**.
- **Lightroom:** "Remove from Collection" takes a photo out of a collection "without deleting the photo from your catalog or hard drive… The photo remains in the original folder and can still be found in other collections." "Delete from Disk" "discards the source image and all data stored in the Catalog, hence the data in related Collections." And — a genuinely excellent UX detail — **the destructive option is context-sensitively withheld: "To get 'Remove from Disk' you have to be in a file system view (Folder). If you are in a Collection, you only get the remove from the current collection"** [32].
- **Google Photos:** "remove from album" removes the pointer from that album only; deleting "removes the original and therefore removes it from all albums" [33].
- **iTunes/Apple Music:** remove-from-playlist ≠ delete-from-library; but note Apple's own labelling is confusing enough that users complain the menu "says 'Delete from Library' but doesn't mean what it says" [iTunes/Apple Music support threads].
- **Zotero:** removing from a collection doesn't delete; and it ships **"Unfiled Items," a special collection showing "only items that do not belong to any collection in your library"** [23].

**The last-group / orphan question.** Three answers exist in the wild:
1. **Implicit universal group** — Gmail's All Mail [30], Lightroom's "All Photographs," DEVONthink's database root. The item is *never* orphaned because it is always a member of the root.
2. **Explicit orphan bucket** — Zotero's **Unfiled Items** [23]. The item is genuinely in zero collections and the UI provides a computed view over "membership set is empty."
3. **Refuse** — reject the removal of the last group.

**[SYNTHESIS]** Options 1 and 2 are the same thing viewed differently, and both are right: **items are stored in a flat collection; group membership is an annotation.** `_uncategorized` should be a **computed projection** (`items where memberships.size === 0`), *not* a real group, because a real group would need a real membership row and you'd have to garbage-collect it on every add. Option 3 is a footgun (it forces the user to invent a junk group to make room for a legitimate removal).

Naming and safety, from the evidence:
- Never label a membership-removal "Delete." Use **"Remove from *{group}*"** with the group name interpolated. Gmail, Lightroom, and Google Photos all do exactly this.
- **Copy Lightroom's context-sensitivity** [32]: when the user's current scope *is* a group, offer only `Remove from {group}`; surface `Delete item` only in the item's home/library scope, or behind a secondary confirm that says *how many other groups* it's in.
- Since removal is non-destructive, **removal need not confirm** (a toast + undo beats a modal). Deletion must.
- Deleting a *group* must ask a different question than deleting an item: "Delete group *X* — its 42 items stay in your library" (Gmail: deleting a label doesn't delete the emails [30]).

## B.5 Drag-and-drop semantics under multi-parent

**In a tree, drag = MOVE.** In a DAG, drag is **ambiguous**: MOVE (re-parent: remove old edge, add new) vs. **ADD-a-parent** (add edge, keep old). This ambiguity is the single most dangerous interaction in the whole design, because the two operations look identical during the drag and differ in whether data disappears from where it was.

What real systems do:

- **macOS Finder** disambiguates with modifiers [34][35]: **no modifier** = move (same volume) / copy (across volumes); **⌥ Option** = copy; **⌘ Command** = move across volumes; **⌥⌘** = make an **alias**. Note the pattern: the *default* is context-dependent, and the *link* operation requires the most-deliberate modifier.
- **Gmail** collapses the ambiguity by *redefining move*: dragging a message onto a label "mirrors the behavior of the 'move' option, which **labels and archives** emails simultaneously" — i.e. it **adds the target label and removes the `Inbox` label** [30]. Gmail's "Move to" tool "assigns the label you selected and **removes all other labels**," whereas the "Labels" tool "assigns the label you selected leaving other existing labels alone" [30]. **Two distinct commands, two distinct verbs, both available.**
- **Zotero:** drag between collections *adds*; hold a modifier to move. (Zotero's whole model is add-oriented; items live in the library, collections are annotations [23].)
- **Are.na:** the verb is literally **"connect"** — you don't move a block, you connect it to another channel; connections accumulate [26].
- **DEVONthink:** duplicate vs. **replicate** are separate explicit commands [22].

**[SYNTHESIS] — the least-surprising default.**

> **Default drag = ADD (connect). Modifier drag = MOVE (re-parent).**

Justification: ADD is **non-destructive and undoable in one click**; MOVE is destructive of an edge the user cannot see (the source edge may be off-screen, or the user may have dragged from a *search result* where there is no meaningful source group at all — a case where MOVE is literally undefined). Making the destructive operation the one that requires deliberate effort inverts Finder, but Finder is a *tree*, where move is the only coherent option. In a DAG, **ADD is the operation the model was built for.**

Non-negotiable supporting requirements:
1. **Show the verb during the drag.** The drop indicator must say `+ Add to Reading` vs `→ Move to Reading` and update live as modifiers are pressed. Never let the user find out afterwards.
2. **Drag from a search result / flat list / tag cloud has no source group → MOVE must be disabled** (grey the modifier affordance). This falls out of "the model has no `currentParent`, only the view does."
3. **Provide both as explicit menu commands** (Gmail's lesson): `Add to group…` and `Move to group…`. Drag is a shortcut for a command that must exist independently — this is also the accessibility path (§D), since drag-and-drop is not keyboard-operable.
4. **Dragging a *group* onto a group** is the multi-parent case for groups, and it is the same choice: add-parent vs re-parent. Same modifier, same live label.

## B.6 Cycle prevention in the UI

A DAG must stay acyclic. Dropping *A* into its own descendant *D* creates a cycle. (In a tree this is the "drop into self/descendant" bug; libraries treat it as a known defect — PrimeVue #8353: "A node can be dropped into itself or one of its descendants, which should be prevented… both nodes can disappear" [42].)

**How real components do it:**
- **AG Grid**: "Moving a parent to be a child of itself is not allowed, as this would create a cycle, and the grid will **prevent this automatically**"; plus an `isRowValidDropPosition` callback for custom rules [41].
- **PrimeVue's fix**: mark the dragged node `data-p-dragging="true"` and set **`pointer-events: none`** on its descendant container — the invalid targets simply stop being targets [42].
- **Atlassian Pragmatic DnD**: a `canDrop()` predicate per drop target; note the gotcha — "returning false from `canDrop()` will **not** block dropping on parent or child drop targets — all drop targets that want to not allow dropping need to return false" [43].

**[SYNTHESIS] — but polyhierarchy makes this harder, and here's the part people get wrong.** In a tree, "is *T* a descendant of *A*?" is a walk up one parent chain — O(depth). **In a DAG it is a reachability query over a graph with multiple parents** — and it must be evaluated against the *node*, not the path. Worse: because a node has many parents, a drop that looks locally innocent (dropping *A* into *T*, where *T* is nowhere near *A* in the current view) can still close a cycle through a branch that isn't on screen. **The user cannot see why it's illegal.** This is qualitatively different from the tree case, where the illegal targets are always visibly inside the thing you're dragging.

Therefore:
1. **Precompute the invalid set at drag-start**, not per-hover: `invalid = {A} ∪ descendants(A)` (full DAG reachability, memoized). Drag-start is the one moment you can afford one traversal.
2. **Render invalidity, don't just reject it.** Disabled drop targets get a distinct style (reduced opacity + `not-allowed` cursor + no drop indicator) — the entire descendant set, everywhere it appears in the view (all path-nodes with an invalid `nodeId`, per §B.3's cross-highlighting).
3. **Explain off-screen invalidity.** When the user hovers an invalid target that isn't visibly a descendant, the tooltip must name the offending path: *"Can't add — Reading is already inside Archive → Research → Reading."* Without this sentence, DAG cycle prevention is indistinguishable from a bug. **This tooltip is the single highest-value piece of polish in the whole DnD story.**
4. Do it in the model, not the renderer: `canAddChild(parent, child) -> { ok: true } | { ok: false, reason: 'cycle', via: GroupId[] }`. The `via` path is what the tooltip renders. Every renderer gets correct behaviour for free — this is exactly the "gesture is not in the model" commitment paying off.

## B.7 Counts under polyhierarchy

Three independent questions, and every product answers them differently — which is why they must be **explicit options**, not defaults you guess at:

**(a) Does a parent's count include descendants?**
- Zotero: **no, by default** — "items added to a subcollection do not automatically appear in parent collections. This can be changed by toggling **'Show Items from Subcollections'** in the View menu" [23]. A *user-facing toggle* for exactly this.
- Faceted search: **yes, always** — Hearst: selecting a label "is equivalent to performing a disjunction over all the labels beneath it" [10]. Solr implements this by *path-encoding at index time* (`0/NonFic`, `1/NonFic/Law`) or `PathHierarchyTokenizerFactory`, which "outputs file path hierarchies as synonyms," expanding `/etc/apache2/conf.d` into `/etc`, `/etc/apache2`, `/etc/apache2/conf.d` — so an item is literally indexed under every ancestor [16].
- Filesystems: size rolls up, file *count* usually doesn't.

**(b) Does an item in two children get counted twice in the parent?**
This is the polyhierarchy-specific one, and the default in every faceting engine is **YES — it double-counts.** Solr, documented plainly: with a multivalued field, "a document with two dates… **will be counted in each bucket**" [15]. That's correct *for a facet* (the buckets are independent). It is **wrong for an ancestor rollup**, where the honest number is `|distinct descendants|` — a set union, not a sum.

**[SYNTHESIS]** The rollup must be a **distinct union of item ids over the transitive closure**, never a sum of child counts. `Σ children.count` is a bug the moment the structure stops being a tree, and it is a *silent* bug — the number is merely wrong, not broken. Two mitigations:
- Compute rollups as `|⋃ descendants(g).items|` (a set-cardinality, memoizable per group; invalidate on edge/membership change).
- Where exact distinct counts are too expensive for the backing store, **say so**: render `~1,240` or `1,240+`. Never render a precise-looking wrong number. (This maps cleanly onto zodal's existing "honest capability reporting" rule for store adapters.)

**(c) Do the facet counts respect the current filter?**
For multi-select facets, **a facet's own filter must be excluded from its own count** — otherwise every unselected value shows 0 and the user can never widen the selection. Solr's mechanism is filter **tagging + domain exclusion**: apply `{!tag=COLOR}color:Blue`, then compute the COLOR facet with `domain:{excludeTags:COLOR}` — "show color options as if the color filter doesn't exist" [14]. Within-facet selections union into one filter (`color:(Blue Black)`); across-facet filters intersect naturally [14]. Hearst's parallel rule: never remove a facet whose count goes to zero — grey it [10].

**[SYNTHESIS]** If zodal-groups exposes group-counts alongside an active filter, it needs the same tag/exclude discipline. Specify count semantics explicitly in the projection API:
```ts
counts: {
  scope: 'direct' | 'descendants',        // Zotero's toggle, as an option
  dedupe: 'distinct' | 'sum',             // 'distinct' is the only honest default
  respectFilter: 'all' | 'exclude-self',  // Solr's tag/exclude, for facet-style UIs
  exact: boolean                          // capability-reported; false → render "~N"
}
```

## B.8 Bulk operations across a group and its descendants

The dangerous surface. "Delete *Research*" — does it delete the 12 sub-groups? The 400 items? The 30 items that are *also* in *Reading*?

**[SYNTHESIS]** The polyhierarchy rules:
1. **Group ops and item ops are different ops.** Deleting a group deletes group nodes and edges. It must **never** cascade into item deletion; items survive as memberships-elsewhere or as orphans (§B.4). Gmail's precedent: deleting a label doesn't delete the emails [30].
2. **Every bulk op takes an explicit scope:** `{ scope: 'direct' | 'descendants' }` — same axis as counts. Mirror Zotero's toggle and Outlook's search scope so the vocabulary is consistent across search *and* mutation [23][48].
3. **The destructive-op preview must state the polyhierarchy consequence:**
   > *Remove 400 items from **Research** and its 12 subgroups. **37 of these items are only in Research** and will become unfiled.*

   That second sentence is the whole game. It is exactly the information a tree UI never has to compute and a DAG UI must. Provide it as a model-level dry-run: `previewRemove(group, {scope}) -> { itemsAffected, itemsOrphaned, groupsAffected }`.
4. Because ADD is cheap and REMOVE is not, bulk-add ("tag all 400") needs no confirm; bulk-remove does.

---

# PART C — How search/filter interacts with the hierarchy

## C.1 Scoping search to a group *and its descendants*

The standard affordance, and the standard *name*, is **scope**:
- Outlook: a **Scope** group on the Search tab with **"All Subfolders"** / "Subfolders" [48].
- Zotero: **"Show Items from Subcollections"** (View menu) [23] — a persistent mode rather than a per-search control.
- Everything faceted: implicit, always-on (selecting a label = disjunction over its subtree [10]).

Implementations: at index time via path-encoding / `PathHierarchyTokenizerFactory` so an item is indexed under every ancestor path [16]; or at query time by expanding the group to its transitive closure and issuing `groupId IN (...)`.

**[SYNTHESIS]** Expose scope as an explicit, user-visible control, and use **one word — `scope`** — across search, counts, and bulk ops. In a DAG, "descendants" means *transitive closure over the group DAG*, deduplicated, cycle-guarded. Cache the closure per group; invalidate on any group-edge write. Store adapters that can't do a closure server-side should report that capability honestly and let the core do it client-side (this is precisely the zodal `ProviderCapabilities` pattern).

## C.2 Hierarchical facets with counts

Hearst's operational rules [10], all of which survive polyhierarchy unchanged (this is the point):
- Step-by-step drill-down beats expand-everything and beats fly-away menus.
- Query previews (counts) on every label, so no drill leads to zero.
- Never hide an emptied facet; grey it.
- Show the immediate children of the selected level, plus a trail of the ancestors just above the labels — i.e. three levels of context visible at once.

Backing implementations [16]: prefix-encoded paths + `facet.prefix`; `PathHierarchyTokenizerFactory`; or **pivot facets** ("decision tree faceting") over one field per level, which "tells you in advance what the 'next' set of facet results would be if you apply a constraint from the current facet results."

## C.3 Conjunctive vs. disjunctive — and communicating it

**The convention** [13]: *"values applied across different facets are normally combined **conjunctively**, while values within a given facet are normally combined **disjunctively**."* Facets may be **single-select**, **multi-select OR**, or **multi-select AND** [13]. Hearst's formulation of the same thing — "a **conjunct of disjuncts**" [10].

Mechanism: within-facet selections become one OR'd filter; across-facet filters AND naturally; each facet's counts are computed with its own filter excluded [14].

**Communicating it in the UI** — the honest answer is that most UIs *don't*, and users infer it. What works:
- **Checkboxes within a facet** (visually "any of these") vs. **separate facet blocks** (visually "and also").
- **Hearst's separated breadcrumb**: one visual chip-group per facet, which "reinforces the notion of the query consisting of a conjunction of different categories" [10]. The visual grouping *is* the operator.
- Explicit connective words between chip-groups (`Tags: a or b` **AND** `Status: open`) when the audience is technical.

**[SYNTHESIS] The polyhierarchy wrinkle worth naming.** Groups are a *single* facet ("which groups is this in?"). Selecting two groups is therefore **OR by convention** — Zotero's new multi-collection selection does exactly this: selecting multiple collections shows "all the items from both," and in advanced search "they'll be moved to their own condition group joined by **'any'**" [25]. But the *most common thing a user actually wants* when they click two groups is often **AND** ("things that are in both Reading and 2024"). Both are legitimate. **Offer an explicit AND/OR toggle on multi-group selection** and default to **OR** (matching the faceted convention and Zotero's precedent) — but make the toggle visible, not buried, because the convention is not intuitive here.

## C.4 Query languages as navigation

The pattern: a **scoped filter grammar** where structural navigation and text search live in one input.

| System | Grammar | Notes |
|---|---|---|
| **Gmail** | `label:work`, `in:inbox`, `in:anywhere`, `has:attachment`, `has:userlabels`, combinable: `from:john has:attachment before:2024/01/01` [31] | `label:` *is* the navigation primitive — clicking a label just runs `label:x` |
| **Obsidian** | `tag:#a/b` matches the nested subtree; `tag:#a` matches "all tags and nested tags under that hierarchy" [58] | subtree-match by path prefix |
| **VS Code** | `@tag:experimental`, `@tag:accessibility`, `@tag:workspaceTrust` in the settings search box [49] | `@`-prefixed structural filters, `:`-separated |
| **Jira JQL** | `parent`, `parentIssuesOf("STORY-001")` (all ancestors, not just immediate), `childrenOfIssuesInQueryRecursive()` with optional depth [50] | explicit *transitive* hierarchy functions — the closest prior art to a DAG query language |
| **Spotlight / Smart Folders** | a saved `.savedSearch` plist holding a **predicate**, not a file list [44] | the query *is* the folder |

**[SYNTHESIS] Proposed scoped grammar for zodal-groups** — deliberately tiny, deliberately mirroring Gmail/VS Code so it's learnable on sight:

```
group:reading              # direct membership
group:reading/*            # membership in reading OR any descendant  (scope, §C.1)
group:reading group:2024   # two terms in the same field → OR   (facet convention)
-group:archive             # negation
in:unfiled                 # the computed orphan projection (§B.4)
has:groups                 # ≥1 membership  (cf. Gmail `has:userlabels`)
groups:>2                  # cardinality of the membership set — a DAG-only query!
paths:>1                   # reachable by more than one path — the "surprise" query
text                       # bare terms → full-text
```

`groups:>2` and `paths:>1` are worth calling out: they are **queries that are meaningless in a tree** and directly useful in a DAG (find the over-tagged; audit the taxonomy for accidental polyhierarchy — cf. Hedden's rule of thumb that "more than 2-3 polyhierarchies across an entire faceted taxonomy should be a cause for review" [38]).

## C.5 Flat results vs. results-in-context

The evidence favours **categorized overviews** over flat lists: Kules & Shneiderman found participants "delved deeper into the results list when they used the grouping interface," and Hearst's synthesis is that "category systems have been shown to be superior to clusters and flat lists in usability studies" [45][46][11]. Also: "if categories are drawn from a classification, taxonomy, or ontology, **the structure should be made visible** as it provides context for individual category labels [and] shows relationships between concepts" [11].

**[SYNTHESIS] The polyhierarchy landmine.** "Show results in context" means grouping the result rows by their group. **In a DAG, a result appears under every group it's in.** A 100-hit search over items averaging 3 memberships renders ~300 rows. The user counts them and gets the wrong number.

Rules:
- **Always show the true distinct hit count separately** and prominently: `100 results in 42 groups` — never let the user infer the count by scanning.
- Offer three result modes and let the app choose: `flat` (one row per item; show membership chips inline — Gmail's model), `grouped` (item may repeat; badge the repeats), `tree` (results shown as a pruned projection of the group DAG, which is Hearst's "show the structure").
- In `grouped` mode, mark repeats explicitly — e.g. a small "also in 2 other groups" affordance on each row. This turns the duplicate from a bug into a feature (it *is* §B.1's reverse-membership, surfaced in results).

## C.6 Saved searches / smart groups as first-class groups

Precedent: **BeOS live queries** → **Spotlight Smart Folders**, where the saved object "doesn't list the files 'contained' by this 'folder', but instead gives the **search predicate**… saved… against its `RawQuery` key" [44]; **Outlook Search Folders** [48]; **iTunes smart playlists** with live updating [44]; **Zotero saved searches** (which the new multi-select treats interchangeably with collections — "select a few saved searches to see the combined results" [25]).

**What breaks when a "group" is a predicate rather than a member list.** Be precise — this is a list of concrete API consequences:

| Operation | Extensional group (member list) | Intensional group (predicate) |
|---|---|---|
| `addItem(g, i)` | write an edge | **undefined** — you'd have to *mutate the item* until it matches the predicate. Some products do this ("apply the tag the smart group filters on"); most refuse. |
| `removeItem(g, i)` | delete an edge | **undefined** — same problem, in reverse and worse (you'd have to remove a property the user may want). |
| Drop target in DnD | valid | **must be rejected** — and the rejection must be explained ("Smart groups update automatically"). |
| `count(g)` | cheap, cacheable | requires evaluating the predicate; may be expensive; may change with no write to *this* group. |
| Membership of item `i` (§B.1) | index lookup | requires evaluating **every** predicate against `i`. O(#smart-groups) per item. |
| Nesting (`g` has children) | edges | children are…? A smart group's "descendants" are ill-defined unless you define predicate-refinement. |
| Reactivity | invalidate on edge write | invalidate on **any item write** that could affect the predicate. |
| Cycles | graph-level check | a predicate can reference *another group* (`group:reading AND tag:x`) → **predicate cycles**, which the group-DAG cycle check will not catch. |

**[SYNTHESIS]** Model smart groups as a **distinct kind on the same interface** — same read surface, restricted write surface:
```ts
type Group =
  | { kind: 'static';  id, name, parents: GroupId[] }
  | { kind: 'smart';   id, name, parents: GroupId[], predicate: Filter }
```
They render identically in every projection (that's the point — the user should be able to browse into one). But:
- `canAddItem(group)` returns `false` for `kind: 'smart'`, and **every** renderer must consult it (drop targets, context menus, bulk ops). This is the same "capability" discipline zodal already uses for store adapters — the *group itself* now reports capabilities.
- Reverse-membership (§B.1) must decide whether smart groups appear in an item's "connections." **They should** (it's true and useful), but they must be **visually distinguished** (different chip style) and **non-removable** (no `×`), because removing them is undefined. The `×` affordance's presence/absence is the whole explanation.
- Guard predicate cycles separately from graph cycles: a smart group whose predicate references a group that (transitively) references it back. Detect at save time, not eval time.

---

# PART D — Accessibility and state

## D.1 ARIA: what the specs actually require, and the polyhierarchy problem

**Roles.** `tree`/`treeitem`/`group` for a pure hierarchy of nodes [1][3]; `treegrid`/`row`/`gridcell` when nodes carry editable tabular data [2]; `feed` for infinite-scroll streams of articles (not applicable to groups) [51]; the **`disclosure` pattern** when you just have expandable link groups — the APG explicitly steers you there and away from `tree` [1].

**States/properties** [1][2][3]:
- `aria-expanded` — **only on parent nodes.** The APG warns that putting it on childless rows means "they would be incorrectly described to assistive technologies as parent rows" [2]. In a lazy-loading DAG, a node with unknown children is a genuine dilemma; resolve it by having the store report `hasChildren` (a capability), not by guessing.
- `aria-selected` / `aria-checked`, `aria-multiselectable` on the container.
- `aria-level`, `aria-posinset`, `aria-setsize` — optional when DOM nesting expresses the structure, **required when it doesn't** (dynamic loading, and *any* virtualized/flat DOM) [1][40].
- Keyboard: the full arrow/Home/End/Enter/type-ahead contract in §A.1 [1][55].

### The `aria-level` question, answered

**What do you do about `aria-level` when a node has multiple parents?**

The spec answers this for us, and the answer is clean once you accept §B.3. Two facts:

1. **`aria-owns` forbids multiple owners.** "Make sure your owned elements have only one owner. **Do not specify the id of an element in more than one other element's `aria-owns` attribute**" [4]. The accessibility tree is a *tree*, by construction. There is no such thing as an a11y node with two parents.
2. **`aria-level` is an integer**, describing "the hierarchical level of an element within a structure" [1] — it has no way to express "level 2 here and level 4 over there."

**[SYNTHESIS] Therefore: `aria-level` is a property of the *path-node*, not the node — and this is not a workaround, it is the correct reading of the spec.** The DAG must be **unfolded into a tree of path-nodes** *before* it reaches the DOM (exactly the `PathNode` from §B.3). Then:

- `aria-level` = `pathNode.depth`. Unambiguous, because the path is what got you here.
- `aria-posinset` / `aria-setsize` = position within *this parent's* child list. Unambiguous for the same reason.
- The DOM `id` / React key = `pathNode.pathKey`, **never** `nodeId` — duplicate DOM ids are invalid HTML and will silently corrupt `aria-owns`, `aria-activedescendant`, and label associations. **This is the concrete bug that a nodeId-keyed tree ships with.**
- The *fact* that a node has other parents is conveyed **not structurally but semantically**: append it to the accessible name via a visually-hidden span or `aria-description` — e.g. *"Reading, tree item, level 3, also in 2 other groups."* Screen-reader users get the polyhierarchy information that sighted users get from Zotero's yellow highlight [24], delivered through the one channel ARIA leaves open.
- Provide a keyboard command for §B.1 ("show other locations") that opens a **`listbox` or menu of the other paths** — a flat, linear, fully-accessible structure — rather than trying to express multi-parenthood in the tree itself. This is the accessible equivalent of the modifier-key highlight, and it's strictly better than it, because it's operable and reads out.

## D.2 Virtualization + tree — the known-hard combo

**The standard approach is universal: flatten to visible rows.** "Flatten the currently visible nodes into a list and use a virtualization library to render only visible rows"; MUI X's Rich Tree View forces `domStructure: "flat"` when virtualization is enabled and it "cannot be changed" [40].

Consequences, in order:

1. **Flat DOM kills structural ARIA.** No nested `role="group"`, no implicit nesting. So `aria-level`, `aria-posinset`, `aria-setsize` become **mandatory** on every row [1][40] — precisely the case the APG carves out. Everything in §D.1 is therefore not optional for any tree that scales.
2. **The flattened row array is the `PathNode[]` from §B.3.** Virtualization and polyhierarchy want *the exact same data structure*. This is the load-bearing insight of the report: **the projection layer should emit a flat, ordered `PathNode[]` with `depth`, `pathKey`, `nodeId`, and let renderers window it.** One structure serves: tree view, treegrid, virtualization, icicle (depth → x, index → y), ARIA, and Miller columns (filter by `path` prefix).
3. **Expansion must be O(1) to query.** Keep expansion as a `Set<pathKey>`; recompute the visible row array as a memoized derivation. Don't traverse the DAG per render.
4. **Fixed row height** unless you can afford a measurement cache (MUI defaults to 32px [40]).
5. **Type-ahead across a virtualized tree** must search the *model*, not the DOM, then scroll-to-index. This is a real trap: the APG requires type-ahead [1], and the rows the user is "typing at" mostly don't exist in the DOM.
6. **Keyboard focus + windowing**: focus can be scrolled out of existence. Use **`aria-activedescendant`** on the tree container (with roving `pathKey` ids) rather than roving `tabIndex` on rows, or you will lose focus on every scroll.

---

# DECISION TABLE — does each pattern survive polyhierarchy?

Constraint profiles: **T** = tree (single parent, single membership) · **F** = flat tags (no group nesting; items multi-membered) · **N** = nested groups (group tree; items multi-membered) · **D** = general DAG (groups multi-parented; items multi-membered).

| Pattern | Survives polyhierarchy? | What must change | Best-fit profiles |
|---|---|---|---|
| **Tree view** (expand-in-place) | ⚠️ With work — the hardest one | Unfold to **path-nodes**; expansion keyed by `pathKey`, selection by `nodeId` (§B.3); cycle guard (`isRecursive`); cross-highlight same `nodeId`; `aria-level` from path depth (§D.1). Hearst's warning applies: users don't expect an item in two folders [10] | T, N; **D only with the full path-node machinery** |
| **Treegrid** | ⚠️ Same as tree, + more | Everything above, plus per-row cells. Highest implementation cost | T, N |
| **Miller columns** | ✅ **Natively** | Almost nothing — "the column stack *is* the path." Miller himself generalized it to directed graphs [5]. Add a "this node has other parents" indicator | **T, N, D** — the standout |
| **Drill-down + Back** | ✅ Natively | Nothing. Only ever shows one path — the one you walked | T, N, D |
| **Breadcrumb — location** | ❌ **Breaks** | Requires an injectable **canonical-parent policy**; and must disclose when the canonical path ≠ the arrival path, or it lies [8][9] | T, N |
| **Breadcrumb — path/trail** | ✅ | Needs navigation context in the projection call; needs a fallback when there's no trail (deep link, search) | T, N, D |
| **Breadcrumb — attribute** | ✅ **Natively** | Nothing — it never claimed a path. Hearst's per-facet chip groups [10] | F, N, D |
| **Faceted browsing** | ✅ **Natively — the reference design** | Nothing structural. Get counts right (§B.7): distinct rollups, tag/exclude for facet counts [14], grey-don't-hide [10] | **F, N, D** |
| **Tag cloud** | ✅ | Nothing. But it's a gestalt/social device, not navigation — slower and less accurate on relational tasks [12] | F, N, D |
| **Hierarchical tag picker** | ✅ | Emit a **set of group ids**, never a path-string. Path-string tags secretly re-impose single-parenthood | F, N, D |
| **Treemap / sunburst** | ❌ **Breaks** | Requires children to *partition* the parent. Needs an explicit weight-apportionment strategy or it double-counts. Also the weakest perceptually [52][53] | T only |
| **Icicle** | ⚠️ | Same partition problem, but consumes the flat `PathNode[]` you already have, and has the best encoding [53]. Acceptable with an explicit "showing paths, not items — total exceeds item count" disclosure | T, N (D with disclosure) |
| **Search-first / query** | ✅ **Natively** | Predicates compose over the membership relation regardless of shape. Add scope (`group:x/*`) and DAG-only predicates (`paths:>1`) | T, F, N, D |
| **Master–detail** | ✅ | Detail pane **must** carry the memberships/"connections" section (§B.1) — this is where polyhierarchy becomes visible | T, F, N, D |
| **Virtualized list** | ✅ | Flatten to `PathNode[]`; `aria-level`/`posinset`/`setsize` become mandatory [1][40] | T, F, N, D |
| **Node-link graph** | ✅ **Natively** | Nothing — it's the only view that shows the DAG as it is. But it's a *taxonomist's* tool, not an end-user's; degrades badly at scale (cf. Wikipedia's 1.16M-category graph, with cycles) | N, D (authoring only) |
| **Drag-and-drop** | ⚠️ **Ambiguous — must be resolved** | Default **ADD**, modifier **MOVE**; live verb in the drop indicator; MOVE disabled from search results; cycle-invalid targets pre-computed and *explained* (§B.5, §B.6) | N, D |
| **Smart / saved groups** | ⚠️ | Read-compatible, write-incompatible. `canAddItem === false`; non-removable chips; separate predicate-cycle check (§C.6) | T, F, N, D |

---

# KEEP / AVOID for zodal-groups

## KEEP

1. **`PathNode[]` as the universal projection output.** One flat, ordered array of `{ nodeId, pathKey, path, depth, isRecursive }` simultaneously solves DAG unfolding, tree-state identity, virtualization, ARIA `aria-level`/`posinset`/`setsize`, icicle layout, and Miller-column filtering. **This is the single most important structural recommendation in this report.** Emit it once, in core; renderers window it.

2. **Split state by concern: expansion → `pathKey`, selection → `nodeId`.** Not a compromise — the correct decomposition. Document it loudly; it is the bug every tree library ships with.

3. **Make breadcrumbs a policy-parameterized projection**, with Instone's three types as first-class [7]: `arrival` | `canonical` | `all` | `attribute`. Default `arrival → canonical` fallback, and **disclose the divergence** rather than silently lying (NN/g's stated failure mode [9]).

4. **Miller columns as a first-class projection.** The most polyhierarchy-native classic browser; its inventor already extended it to directed graphs [5]; GOV.UK shipped it as a *taxonomy picker* [6]. It is the cheapest correct DAG browser you can ship.

5. **Faceted browsing as the reference navigation model**, with Hearst's semantics verbatim: **"a conjunct of disjuncts"** — within-facet OR, across-facet AND, ancestor label = disjunction over its subtree [10]. Grey out emptied facets, never hide them [10].

6. **Reverse-membership ("connections") as a first-class provider capability** and a first-class item affordance. `getGroupsOf(itemId)` in the contract; a removable-chip list in every detail pane (Gmail [30], Are.na [26], Zotero 7 [24]); a modifier-key "highlight all locations" in every tree (Zotero's yellow [24]).

7. **Remove ≠ delete, everywhere, in the copy and in the API.** `removeFromGroup(item, group)` vs `deleteItem(item)`. Interpolate the group name into the label. Copy Lightroom's context-sensitivity: don't even *offer* Delete while the user is scoped to a group [32]. `_uncategorized` is a **computed projection** (`memberships.size === 0`), à la Zotero's Unfiled Items [23] — never a real group.

8. **Drag default = ADD, modifier = MOVE**, with the verb rendered live in the drop indicator, and MOVE disabled where there is no source group (search results, flat lists). Gmail's two-verb split (`Label` vs `Move to`) is the precedent [30]; provide both as menu commands, because DnD is not keyboard-accessible.

9. **Cycle prevention in the model, with an explanation:** `canAddChild(p, c) -> { ok: false, reason: 'cycle', via: [...] }`. Precompute the invalid set at drag-start; render *why* — *"Reading is already inside Archive → Research → Reading."* Off-screen invalidity is the DAG-specific failure and the tooltip is its only cure.

10. **Honest counts.** Rollup = **distinct union over the transitive closure**, never `Σ children.count`. Expose `{ scope, dedupe, respectFilter, exact }` explicitly. When the store can't do exact distinct counts, render `~N` — consistent with zodal's existing capability-honesty rule.

11. **A tiny Gmail/VS-Code-shaped filter grammar** (`group:x`, `group:x/*`, `-group:y`, `in:unfiled`, `has:groups`) — plus the DAG-only predicates `groups:>N` and `paths:>1`, which are taxonomy-audit tools that simply do not exist in a tree (cf. Hedden's "more than 2-3 polyhierarchies… should be a cause for review" [38]).

12. **A dry-run API for destructive bulk ops** returning `{ itemsAffected, itemsOrphaned, groupsAffected }`. The sentence *"37 of these items are only in Research and will become unfiled"* is the thing a tree UI never had to compute and a DAG UI must.

## AVOID

1. **Do not teach polyhierarchy through a folder-tree metaphor.** Hearst's finding, unchanged since 2006: "users would be unfamiliar with the idea of an item simultaneously residing in multiple folders, since Explorer does not support that functionality" [10]. Google Drive reached the same conclusion the expensive way and **removed multi-parenting entirely**, replacing it with visible shortcut objects [28][29]. If your primary UI is a folder tree, either **materialize the extra parents as visible link-objects** (Drive shortcuts / DEVONthink replicants [22] / ODP symbolic links [36]) or lead with a different projection.

2. **Never key DOM ids, React keys, or `aria-owns` by `nodeId` in a DAG.** Duplicate ids are invalid HTML and will silently corrupt `aria-activedescendant` and label associations. `aria-owns` explicitly permits only one owner [4].

3. **Never sum child counts.** `Σ children.count` is a silent wrongness the instant the structure stops being a tree.

4. **Don't ship treemaps/sunbursts over a DAG** without an explicit weight-apportionment strategy. They *assert* a partition that a DAG doesn't have. (And they're the weakest hierarchy encodings anyway [52][53].)

5. **Don't encode hierarchy as path-strings** (`#work/2024/q1`) in the model. It's a rendering of one tree projection, and it quietly forbids a group from having two parents — the exact limitation zodal-groups exists to remove.

6. **Don't let a smart/saved group be a drop target**, and don't put an `×` on a smart-group chip. Both operations are undefined; the missing affordance *is* the explanation [44][§C.6].

7. **Don't personalize the location breadcrumb silently.** NN/g's objection is right *as stated* [8]: an unstable, unexplained trail is worse than a wrong-but-consistent one. The fix is disclosure, not personalization.

8. **Don't build multi-path breadcrumbs that enumerate all paths without truncation.** Path count is exponential in DAG depth. MeSH truncates secondary tree locations "at the third level" and renders them "in smaller type" [21] — copy that discipline exactly.

9. **Don't make the tree view the only projection.** It's the pattern that survives polyhierarchy *least* well and costs the most to get right. Search, facets, Miller columns, and master–detail all survive it natively — and all four are cheaper.

10. **Don't confirm non-destructive operations.** Adding a membership and removing a membership are both cheap and reversible; a toast with Undo beats a modal. Save the modals for actual deletion, where the dry-run preview (KEEP #12) earns its keep.

---

## REFERENCES

1. [Tree View Pattern — WAI-ARIA Authoring Practices Guide (APG), W3C](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)
2. [Treegrid Pattern — WAI-ARIA Authoring Practices Guide (APG), W3C](https://www.w3.org/WAI/ARIA/apg/patterns/treegrid/)
3. [ARIA: tree role — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/tree_role)
4. [ARIA: aria-owns attribute — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Attributes/aria-owns)
5. [Miller columns — Wikipedia](https://en.wikipedia.org/wiki/Miller_columns)
6. [alphagov/miller-columns-element — Miller columns for hierarchical topic selection on GOV.UK](https://github.com/alphagov/miller-columns-element)
7. [Keith Instone. Location, Path & Attribute Breadcrumbs (IA Summit)](http://instone.org/files/KEI-Breadcrumbs-IAS.pdf)
8. [Breadcrumbs: 11 Design Guidelines for Desktop and Mobile — Nielsen Norman Group](https://www.nngroup.com/articles/breadcrumbs/)
9. [Polyhierarchies Improve Findability for Ambiguous IA Categories — Nielsen Norman Group](https://www.nngroup.com/articles/polyhierarchy/)
10. [Marti A. Hearst. Design Recommendations for Hierarchical Faceted Search Interfaces. ACM SIGIR Workshop on Faceted Search, 2006](https://flamenco.berkeley.edu/papers/faceted-workshop06.pdf)
11. [Marti A. Hearst. Search User Interfaces, Ch. 8 — Integrating Navigation with Search. Cambridge University Press, 2009](https://searchuserinterfaces.com/book/sui_ch8_navigation_and_search.html)
12. [Marti A. Hearst & Daniela Rosner. Tag Clouds: Data Analysis Tool or Social Signaller? HICSS-41, 2008](https://flamenco.berkeley.edu/papers/tagclouds.pdf)
13. [Designing Faceted Search: Getting the Basics Right (part 2) — Information Interaction (Tony Russell-Rose)](https://isquared.wordpress.com/2011/06/29/designing-faceted-search-getting-the-basics-right-part-2/)
14. [Yonik Seeley. Multi-Select Faceting in Solr](https://yonik.com/multi-select-faceting/)
15. [Faceting — Apache Solr Reference Guide](https://solr.apache.org/guide/solr/latest/query-guide/faceting.html)
16. [Approaches to Hierarchical Faceting in Solr — Apache Solr Wiki](https://cwiki.apache.org/confluence/display/solr/HierarchicalFaceting)
17. [Peter Pirolli & Stuart K. Card. Information Foraging. PARC UIR Technical Report, 1999](https://act-r.psy.cmu.edu/wordpress/wp-content/uploads/2012/12/280uir-1999-05-pirolli.pdf)
18. [Information Foraging: A Theory of How People Navigate on the Web — Nielsen Norman Group](https://www.nngroup.com/articles/information-foraging/)
19. [Thomas W. Malone. How Do People Organize Their Desks? Implications for the Design of Office Information Systems. ACM TOIS 1(1), 1983](http://dl.acm.org/citation.cfm?id=357423.357430)
20. [MeSH Tree Structures — U.S. National Library of Medicine](https://www.nlm.nih.gov/mesh/intro_trees.html)
21. [MeSH Browser Overview — U.S. National Library of Medicine](https://www.nlm.nih.gov/mesh/mbinfo.html)
22. [How to Use Duplicates and Replicants — DEVONtechnologies](https://www.devontechnologies.com/blog/20230524-duplicates-replicants)
23. [Collections and Tags — Zotero Documentation](https://www.zotero.org/support/collections_and_tags)
24. [Collections Containing an Item — Zotero Knowledge Base](https://www.zotero.org/support/kb/collections_containing_an_item)
25. [Available for beta testing: Multi-collection selection — Zotero Forums](https://forums.zotero.org/discussion/132514/available-for-beta-testing-multi-collection-selection)
26. [Connections — Are.na Help](https://help.are.na/docs/getting-started/connections)
27. [Blocks — Are.na Developer Documentation](https://dev.are.na/documentation/blocks)
28. [Simplifying Google Drive's folder structure and sharing models — Google Workspace Blog](https://workspace.google.com/blog/product-announcements/simplifying-google-drives-folder-structure-and-sharing-models)
29. [Shortcuts replacing items stored in multiple locations — Google Workspace Admin Help](https://support.google.com/a/answer/10686746)
30. [Create & manage labels in Gmail — Gmail Help](https://support.google.com/mail/answer/118708)
31. [Refine searches in Gmail (search operators) — Gmail Help](https://support.google.com/mail/answer/7190)
32. [Remove from Collection vs Delete from Disk and Remove from Lightroom — Adobe Community](https://community.adobe.com/t5/lightroom-classic-discussions/remove-from-collection-vs-delete-from-disk-and-remove-from-lightroom/td-p/12068229)
33. [Deleting photos in album — Google Photos Community](https://support.google.com/photos/thread/669385/deleting-photos-in-album)
34. [Mac keyboard shortcuts (drag modifiers) — Apple Support](https://support.apple.com/en-us/102650)
35. [How to copy and move files and make shortcuts in the macOS Finder — Macworld](https://www.macworld.com/article/561987/how-to-copy-and-move-files-make-shortcuts-macos-finder.html)
36. [Saverio Perugini. Symbolic links in the Open Directory Project. Information Processing & Management 44(2), 2008](https://www.semanticscholar.org/paper/Symbolic-links-in-the-Open-Directory-Project-Perugini/60923ff3ff8dc9cc529fd7266fe559af5bd15e98)
37. [Saverio Perugini. Supporting multiple paths to objects in information hierarchies: Faceted classification, faceted search, and symbolic links. Information Processing & Management, 2010](https://ecommons.udayton.edu/cps_fac_pub/17/)
38. [Heather Hedden. Polyhierarchy in Taxonomies — Hedden Information Management](https://www.hedden-information.com/polyhierarchy-in-taxonomies/)
39. [SKOS Simple Knowledge Organization System Reference — W3C](https://www.w3.org/TR/skos-reference/)
40. [Rich Tree View — Virtualization — MUI X](https://mui.com/x/react-tree-view/rich-tree-view/virtualization/)
41. [Tree Data — Row Dragging (cycle prevention) — AG Grid](https://www.ag-grid.com/javascript-data-grid/tree-data-row-dragging/)
42. [Tree Drag and Drop Does Not Prevent Dropping a Node Into Itself or Descendants — PrimeVue issue #8353](https://github.com/primefaces/primevue/issues/8353)
43. [Pragmatic drag and drop — Drop targets (canDrop) — Atlassian Design System](https://atlassian.design/components/pragmatic-drag-and-drop/core-package/drop-targets)
44. [How to search successfully in Spotlight: Saved Search — The Eclectic Light Company](https://eclecticlight.co/2025/06/03/how-to-search-successfully-in-spotlight-saved-search/)
45. [Bill Kules & Ben Shneiderman. Categorized Overviews of Search Results — HCIL Tech Report](http://www.cs.umd.edu/hcil/trs/2005-31/2005-31.htm)
46. [Bill Kules et al. Users Can Change Their Web Search Tactics: Design Guidelines for Categorized Overviews](https://www.cs.umd.edu/~ben/papers/Kules2008Users.pdf)
47. [Information foraging — Wikipedia](https://en.wikipedia.org/wiki/Information_foraging)
48. [Use Search Folders to find messages or other Outlook items — Microsoft Support](https://support.microsoft.com/en-us/office/use-search-folders-to-find-messages-or-other-outlook-items-c1807038-01e4-475e-8869-0ccab0a56dc5)
49. [User and workspace settings (@tag filters) — Visual Studio Code Docs](https://code.visualstudio.com/docs/configure/settings)
50. [Jira Hierarchy & Advanced Roadmaps JQL Functions — Appfire / JQL Search Extensions](https://appfire.atlassian.net/wiki/spaces/JQLSEARCH/pages/604209353)
51. [Feed Pattern — WAI-ARIA Authoring Practices Guide (APG), W3C](https://www.w3.org/WAI/ARIA/apg/patterns/feed/)
52. [Interactive Visualisation of Hierarchical Quantitative Data: An Evaluation (IEEE VIS, 2019)](https://arxiv.org/pdf/1908.01277)
53. [Effective Visualization of Hierarchies — University of Bamberg Visualization Group](https://vis-uni-bamberg.github.io/hierarchy-vis/)
54. [Using Degree Centrality to Break Wikipedia Category Cycles](https://willbeason.com/2021/09/11/using-degree-centrality-to-break-wikipedia-category-cycles/)
55. [Developing a Keyboard Interface — WAI-ARIA Authoring Practices Guide (APG), W3C](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
56. [Overview of DeCS/MeSH tree structure — DeCS / BVS](https://decs.bvsalud.org/en/overview-of-decss-tree-structure/)
57. [Roam user's guide to Tana (supertags) — Tana](https://outliner.tana.inc/articles/roam-user-s-guide-to-tana)
58. [Tags — Obsidian Help](https://help.obsidian.md/tags)
