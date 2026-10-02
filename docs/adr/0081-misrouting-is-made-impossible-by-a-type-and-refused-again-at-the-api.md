# ADR 0081 — misrouting is made IMPOSSIBLE by a type, and refused again at the API

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** C-AUTO-09
- **Covers:** docs/01 decisions — none; this is a decision about the shape of one authoring surface
- **Supersedes nothing. Rests on:** [ADR 0002](0002-typescript-6-not-7.md),
  [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md) and
  [ADR 0008](0008-unit-of-work-and-exactly-once-per-handler.md)

## Context

C-AUTO-09's title is its specification: *a node-graph journey builder, with misrouting made impossible*.
The builder itself is the easy half. The hard requirement is that an operator must not be able to route
promotional content through a transactional template — and the five other ways a graph can be wired
wrong: an edge out of a terminal step, an edge back into the trigger, an edge on a branch the source does
not declare, two edges leaving one branch, and a branch with no edge at all.

C-AUTO-06 already refuses every one of those. `validateFlowDefinition` names them —
`flow-dsl-message-class-mismatch`, `flow-dsl-edge-into-the-trigger`,
`flow-analysis-ambiguous-branch`, `flow-analysis-condition-branch-missing` — and refuses to publish a
document that holds any of them. So the cheapest reading of this unit's acceptance line was already
satisfied before a line of it was written: draw whatever you like, press save, read the refusal.

That reading is wrong, and the word in the acceptance line is why. A builder that offers an operator a
connection and then refuses it at save time **has made misrouting possible and then caught it**. Nothing
was published, which is what matters for the enrolments on the live version; but the operator was told no
about a thing the screen offered them, and "the screen offered it" is the defect. The acceptance asks for
a graph whose wrong edges cannot be expressed.

## Decision

**The authoring surface is typed so that the six wrong edges have no name, and the API refuses them
again anyway.**

In `packages/core/src/automation/dsl.ts`, a journey is composed from a specification whose `edges` field
is a **total mapped type over the outlets**:

```ts
type JourneyEdgeMap<T extends string, N extends JourneySteps> = {
  readonly [K in JourneyOutletKey<T, N>]: keyof N & string
}
```

Six consequences, each a compile error rather than a refusal:

1. `exitStep` is `JourneyStep<never>`, so `` `${id}:${never}` `` is `never` and an exit contributes no
   outlet key. **An edge out of an exit is an excess property.**
2. The trigger is a field of the specification rather than a member of the step record, so the map's
   VALUE type is `keyof steps`. **An edge into the trigger has nowhere to land**, and "exactly one
   trigger" is structural rather than a refusal.
3. The keys are `` `${id}:${branch}` `` derived from each step's own branch labels. **A branch a kind
   does not declare is not a key.**
4. An object literal cannot have the same key twice. **Two edges on one branch is a TypeScript error.**
5. Every key is required. **A condition with one answer, a split with an unrouted share and a
   non-terminal step with no way out are all missing properties.**
6. `classedMessageStep` takes a `TemplateRef<NoInfer<C>>` beside `messageClass: C`, and a `TemplateRef`
   is minted only by `templateChoicesFor(registry, class)` — behind a `unique symbol` this module does
   not export. **A promotional step bound to a transactional template does not typecheck**, and the
   class on the node is READ off the reference rather than declared beside it, so there is only one
   statement of it.

For the interactive surface — a half-drawn graph cannot be a literal — the same six are kept by a
different mechanism: an edge is drawn by passing an OFFER (`JourneyOutlet`, `JourneyInlet`) that only
`freeOutletsOf` and `inletsOf` can mint, and `resolveJourneyOutlet` is the one place an untyped HTTP body
becomes a typed edge. The builder's two `<select>`s are filled from those same two functions, so a
misrouting is not selectable; a crafted body resolves to `null` and is refused as `edge_not_offered`.

And `POST /crm/flows/api` runs `validateFlowDefinition` over whatever arrives, with the template registry
read from `message_template` per request. A type stops at the process boundary; a caller with `curl` is
not holding a `TemplateRef`.

## The alternatives, and the specific way each one fails here

**Validate at save time and show the operator the refusals.** This is what the DSL already does, and it
is retained — but as the API's answer to a document that did not come from the builder, not as the
builder's model. As the model it fails in the way the acceptance names: the screen offers a connection it
will refuse. It also fails a second way that is harder to see. The refusal list is computed over the
whole document, so one wrong edge produces several refusals (an unreachable node, a missing branch, no
exit reachable), and an operator shown nine rules for one mistake fixes the wrong one.

**Filter the template picker in the view.** A filter in a renderer is a filter somebody can forget, and
the symptom of forgetting it is a picker that offers a binding the save will refuse — the same defect one
layer out. `templateChoicesFor` is therefore the picker's list AND the binding's type, from one call: a
list that showed more could not produce a reference for the extra rows.

**Make the class a plain field and compare it to the registry at save.** That is one statement of the
class in the node and another in the template, which is the shape the brief's "a second statement of a
fact drifts" is about — and the direction it drifts in is the bad one. A promotional node bound to
`booking.confirmed` leaves from the transactional sender identity, outside the promotional window, with
no opt-out route, and every part of that is a TDRA problem rather than a cosmetic one (docs/04 §5).

**Infer the class from both arguments.** Without `NoInfer`, `C` is inferred from `messageClass` AND from
`template`, TypeScript unions the two candidates, and `{ messageClass: 'promotional', template: <a
transactional ref> }` typechecks against `C = 'transactional' | 'promotional'`. A generic that accepts
everything is the failure mode a type-level claim has to be able to SHOW cannot happen, which is why gate
case 159e removes `NoInfer` and requires `TS2578` back.

That case is also the reason this record can make the claim at all, and the episode is worth keeping.
159e reported "exited zero; nothing was rejected" the first time it ran, and the conclusion drawn — that
`NoInfer` was belt and braces — was wrong. The two directives were erroring for a different reason:
`PROMOTIONAL[0]` is `TemplateRef<'promotional'> | undefined`, module-scope narrowing does not reach
inside a nested function, and what they suppressed was `Type 'undefined' is not assignable`. The claim
was satisfied for the wrong reason and would have stayed satisfied with the tie cut entirely. `mustHold`
in `journey.test.ts` is the fix; re-measured against it, removing `NoInfer` reports `TS2578` twice and so
does widening the template to `TemplateRef<MessageClass>`. A gate case found a vacuous type-level claim
that no review had — which is ADR 0003 doing its job on the one assertion in this unit that cannot be
checked any other way.

**Store the draft in a table.** `flow_definition` refuses UPDATE (ZF001) precisely so a published version
cannot be edited under the enrolments pinned to it, so the operator's work in progress is *not a
version*. A `flow_draft` table would be a second place a graph lives, with its own concurrency question
and its own migration. The draft travels in a hidden form field instead, which is the whole of what a
screen whose edits are one request each needs — and it is why this unit allocates no migration.

## Consequences somebody will have to live with

**A type is not a runtime check, and both layers have to stay.** Deleting the API's
`validateFlowDefinition` call because "the builder cannot produce a bad graph" would be exactly wrong:
the builder is one caller. Gate block 159 holds both halves open, and the known-bad fixture for the type
half is a `@ts-expect-error` that stops erroring — `TS2578`, a build failure.

**The quantitative rules are still runtime refusals, and that is not a retreat.** A type can express the
SHAPE of a routing and cannot express a quantity or a reachability: the node ceiling, the delay ceiling,
the accumulated path delay, an unreachable node, a loop with no delay or no bounded exit, a duplicate
node id and an unknown template key all stay with `validateFlowDefinition`. They are also not
misroutings — every one of them is a legitimate intermediate state of somebody's afternoon, which is the
reason `JourneyDraft` and `FlowDefinition` are different types.

**`splitStep`'s branch labels must be literals.** A split's outlets come from its own labels, so they
have to be in the type — which means a label chosen at runtime cannot carry one. The builder's split
therefore offers a closed list of share sets rather than free labels, and a unit that wants arbitrary
labels on the canvas has to decide whether the edge map can stay total.

**Two documents of one journey must not exist.** `orderJourneyDocument` is shared by the composer and the
builder so that a journey drawn in one order and written as a literal in another serialise identically.
It is deliberately NOT inside `serialiseFlowDefinition`: that function's contract is the byte form of the
document it is given, and `flow-corpus.test.ts` asserts twelve committed files equal its output exactly.

**The canvas is deferred, and the guarantee is not.** `reactflow` is not in `apps/web/package.json` and
adding a dependency is `pnpm deps`' decision rather than one to make quietly, so the builder ships as the
accessible list the acceptance asks for as a fallback — a `<table>` of steps, a `<table>` of
connections, native controls, and no script at all. A canvas drawn over the same offers inherits the
whole guarantee, because the guarantee is in `packages/core` and not in the view.
