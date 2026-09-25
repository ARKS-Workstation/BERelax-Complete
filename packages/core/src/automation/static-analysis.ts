/**
 * The flow graph, analysed before anything is published.
 *
 * A definition whose every field is valid can still be a flow that cannot be run: a node nothing leads
 * to, a condition with one branch, a loop with no way out, a path that waits eight months. None of those
 * is visible in a document — they are properties of a GRAPH — and every one of them presents in
 * production as an enrolment that stops or never stops, weeks after somebody drew it.
 *
 * So publication is refused for each of them, by name. `validateFlowDefinition` in `dsl.ts` runs this
 * after the shape and integrity checks have passed, never before: an analyser over a document with an
 * unknown node kind or an edge naming a node that is not there reports refusals about the damage rather
 * than about the cause.
 *
 * ## The three rules the acceptance names, and what each one actually means
 *
 * **A non-terminal node with no outgoing edge.** `exit` is the only terminal kind
 * (`FLOW_TERMINAL_NODE_KINDS`), so every other node must lead somewhere. An enrolment that reaches a
 * dead end is neither running nor finished, and no report can say which — the interpreter would have to
 * invent a status for it.
 *
 * **A cycle with no bounded exit.** A loop is legitimate — a nurture sequence that keeps trying until
 * the customer books is the obvious one — but only if it can be LEFT. Two conditions, and they are
 * separate rules because they fail differently: the cycle must have an edge to a node outside it from
 * which an `exit` is reachable (`flow-analysis-cycle-has-no-bounded-exit`), and it must contain a delay
 * (`flow-analysis-cycle-has-no-delay`). Without the escape the enrolment can never end; without the
 * delay it spins as fast as the worker can poll, which C-AUTO-07's execution cap stops after 200 steps —
 * a cap is a backstop for a bug, not a substitute for refusing to publish one.
 *
 * **A path whose accumulated delay exceeds the maximum.** Computed over the CONDENSATION of the graph:
 * each strongly-connected component contributes the sum of the delays inside it, once, and the longest
 * path is taken over the resulting DAG. One pass per cycle, deliberately. The alternative, the longest
 * SIMPLE path, is NP-hard and on a dense 60-node graph is a test that hangs rather than fails (brief
 * rule 21 — there is no `testTimeout` in the unit suite, so the budget is 5,000 ms). The condensation
 * answers the question that matters — "how long can this flow hold somebody before it decides anything"
 * — in one linear pass, and a repeat through a cycle is bounded by the interpreter's execution cap
 * rather than by arithmetic here.
 */
import {
  FLOW_CONDITION_BRANCHES,
  FLOW_DEFAULT_BRANCH,
  FLOW_TERMINAL_NODE_KINDS,
  type FlowDefinition,
  type FlowNode,
  type FlowRefusal,
  type FlowRule,
  MAX_FLOW_ACCUMULATED_DELAY_MINUTES,
} from '@berelax/shared'

export interface FlowGraphFacts {
  /** Every node id an enrolment can reach from the trigger, in breadth-first order. */
  readonly reachableNodeIds: readonly string[]
  /** The longest accumulated delay, in minutes, over the condensation described in the header. */
  readonly maxAccumulatedDelayMinutes: number
  /** Each cycle as its node ids, sorted. A self-loop is a cycle of one. */
  readonly cycles: readonly (readonly string[])[]
}

export interface FlowAnalysis {
  readonly facts: FlowGraphFacts
  readonly refusals: readonly FlowRefusal[]
}

const refusal = (rule: FlowRule, at: string | null, detail: string): FlowRefusal => ({
  rule,
  at,
  detail,
})

const isTerminal = (node: FlowNode): boolean =>
  (FLOW_TERMINAL_NODE_KINDS as readonly string[]).includes(node.kind)

/** The branches a node of this kind may have, which is also exactly the set it MUST have. */
export function declaredBranchesOf(node: FlowNode): readonly string[] {
  switch (node.kind) {
    case 'exit':
      return []
    case 'condition':
      return FLOW_CONDITION_BRANCHES
    case 'split':
      return node.branches.map((branch) => branch.label)
    default:
      return [FLOW_DEFAULT_BRANCH]
  }
}

/**
 * The analysis. Pure, total, and linear in the graph.
 *
 * Takes a definition whose shape and integrity have already been checked — every edge names a node that
 * exists, ids are unique, there is exactly one trigger. Those preconditions are `checkFlowIntegrity`'s,
 * and this function reads an edge to a missing node as no edge at all rather than throwing, so a caller
 * that ignores the order still gets refusals instead of a crash.
 */
export function analyseFlowGraph(definition: FlowDefinition): FlowAnalysis {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const out: FlowRefusal[] = []

  /** from -> branch -> to, plus the raw out-edges, so branch completeness and reachability share one pass. */
  const outgoing = new Map<string, { branch: string; to: string }[]>()
  for (const node of definition.nodes) outgoing.set(node.id, [])
  for (const edge of definition.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue
    outgoing.get(edge.from)?.push({ branch: edge.branch, to: edge.to })
  }

  for (const node of definition.nodes) {
    const edges = outgoing.get(node.id) ?? []
    const declared = declaredBranchesOf(node)

    if (!isTerminal(node) && edges.length === 0) {
      out.push(
        refusal(
          'flow-analysis-non-terminal-node-has-no-outgoing-edge',
          node.id,
          `A ${node.kind} node must lead somewhere. An enrolment that arrives here is neither running ` +
            'nor finished, and nothing can say which.',
        ),
      )
    }

    for (const edge of edges) {
      if (!declared.includes(edge.branch)) {
        out.push(
          refusal(
            'flow-analysis-edge-branch-not-declared',
            `${node.id} -${edge.branch}->`,
            `A ${node.kind} node has no branch called "${edge.branch}". Its branches are ` +
              `${declared.length === 0 ? 'none — it is terminal' : declared.join(', ')}.`,
          ),
        )
      }
    }

    for (const branch of declared) {
      const taken = edges.filter((edge) => edge.branch === branch)
      if (taken.length > 1) {
        out.push(
          refusal(
            'flow-analysis-ambiguous-branch',
            `${node.id} -${branch}->`,
            'Two edges leave one branch, so the interpreter would have to choose, and the two runs ' +
              'would differ for reasons no step log could explain.',
          ),
        )
      }
      // Only a condition and a split get a per-branch refusal. Every other kind declares exactly one
      // branch, so "the default branch has no edge" and "this node has no outgoing edge" are the same
      // fact, and reporting both makes one mistake read as two — which is how an operator comes to fix
      // the wrong one. The no-outgoing-edge rule above is the one that names it.
      if (taken.length === 0 && node.kind === 'condition') {
        out.push(
          refusal(
            'flow-analysis-condition-branch-missing',
            `${node.id} -${branch}->`,
            `The condition has no "${branch}" branch. A condition answers both ways, so the missing ` +
              'answer is an enrolment with nowhere to go for half of its contacts.',
          ),
        )
      }
      if (taken.length === 0 && node.kind === 'split') {
        out.push(
          refusal(
            'flow-analysis-split-branch-missing',
            `${node.id} -${branch}->`,
            `The split declares a "${branch}" branch with a weight and no edge, so that share of the ` +
              'audience is routed nowhere.',
          ),
        )
      }
    }
  }

  const trigger = definition.nodes.find((node) => node.kind === 'trigger')
  const reachable = trigger === undefined ? [] : breadthFirst(trigger.id, outgoing)
  const reachableSet = new Set(reachable)

  for (const node of definition.nodes) {
    if (!reachableSet.has(node.id)) {
      out.push(
        refusal(
          'flow-analysis-unreachable-node',
          node.id,
          'Nothing leads here from the trigger. A node an enrolment cannot reach is either a step ' +
            'somebody meant to wire up or a step somebody forgot to delete, and the published flow does ' +
            'less than the picture of it suggests.',
        ),
      )
    }
  }

  if (
    trigger !== undefined &&
    !reachable.some((id) => {
      const node = nodes.get(id)
      return node !== undefined && isTerminal(node)
    })
  ) {
    out.push(
      refusal(
        'flow-analysis-no-exit-reachable',
        trigger.id,
        'No exit is reachable from the trigger, so no enrolment on this flow can ever finish.',
      ),
    )
  }

  const components = stronglyConnectedComponents(reachable, outgoing)
  const cycles = components
    .filter((component) => isCycle(component, outgoing))
    .map((component) => [...component].sort())

  for (const cycle of cycles) {
    const member = new Set(cycle)
    if (!cycle.some((id) => nodes.get(id)?.kind === 'delay')) {
      out.push(
        refusal(
          'flow-analysis-cycle-has-no-delay',
          cycle.join(', '),
          'A loop with no delay in it runs as fast as the worker can poll. The interpreter halts at its ' +
            'execution cap, which is a backstop for a bug rather than a schedule.',
        ),
      )
    }
    const escapes = cycle.flatMap((id) =>
      (outgoing.get(id) ?? []).filter((edge) => !member.has(edge.to)).map((edge) => edge.to),
    )
    const bounded = escapes.some((target) =>
      breadthFirst(target, outgoing).some((id) => {
        const node = nodes.get(id)
        return node !== undefined && isTerminal(node)
      }),
    )
    if (!bounded) {
      out.push(
        refusal(
          'flow-analysis-cycle-has-no-bounded-exit',
          cycle.join(', '),
          'This loop has no edge leaving it from which an exit can be reached, so an enrolment that ' +
            'enters it can never finish. A loop is allowed; a loop with no way out is not.',
        ),
      )
    }
  }

  const maxAccumulatedDelayMinutes =
    trigger === undefined ? 0 : longestDelay(trigger.id, outgoing, components, nodes)

  if (maxAccumulatedDelayMinutes > MAX_FLOW_ACCUMULATED_DELAY_MINUTES) {
    out.push(
      refusal(
        'flow-analysis-accumulated-delay-exceeds-maximum',
        null,
        `One path accumulates ${maxAccumulatedDelayMinutes} minutes of delay and the maximum is ` +
          `${MAX_FLOW_ACCUMULATED_DELAY_MINUTES}. A flow that holds somebody for longer than that is a ` +
          'message arriving about a visit neither party remembers.',
      ),
    )
  }

  return {
    facts: { reachableNodeIds: reachable, maxAccumulatedDelayMinutes, cycles },
    refusals: out,
  }
}

function breadthFirst(
  from: string,
  outgoing: ReadonlyMap<string, readonly { branch: string; to: string }[]>,
): readonly string[] {
  const seen = new Set<string>([from])
  const order: string[] = [from]
  for (let at = 0; at < order.length; at += 1) {
    const id = order[at] as string
    for (const edge of outgoing.get(id) ?? []) {
      if (seen.has(edge.to)) continue
      seen.add(edge.to)
      order.push(edge.to)
    }
  }
  return order
}

/**
 * Tarjan's strongly-connected components over the reachable subgraph, iteratively.
 *
 * Iterative rather than recursive because the recursion depth is the path length and a 60-node chain is
 * within any stack — but the shape of a flow is authored data, and a limit that holds for every graph
 * anybody can write is worth more than one that holds for every graph anybody has written.
 *
 * Returned in reverse topological order, which is what Tarjan produces and what the delay DP below
 * consumes: a component is emitted only after everything it can reach.
 */
function stronglyConnectedComponents(
  reachable: readonly string[],
  outgoing: ReadonlyMap<string, readonly { branch: string; to: string }[]>,
): readonly (readonly string[])[] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: string[][] = []
  let next = 0

  for (const root of reachable) {
    if (index.has(root)) continue
    const work: { id: string; at: number }[] = [{ id: root, at: 0 }]
    index.set(root, next)
    low.set(root, next)
    next += 1
    stack.push(root)
    onStack.add(root)

    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; at: number }
      const edges = outgoing.get(frame.id) ?? []
      if (frame.at < edges.length) {
        const target = (edges[frame.at] as { to: string }).to
        frame.at += 1
        if (!index.has(target)) {
          index.set(target, next)
          low.set(target, next)
          next += 1
          stack.push(target)
          onStack.add(target)
          work.push({ id: target, at: 0 })
        } else if (onStack.has(target)) {
          low.set(frame.id, Math.min(low.get(frame.id) ?? 0, index.get(target) ?? 0))
        }
        continue
      }
      work.pop()
      const parent = work[work.length - 1]
      if (parent !== undefined) {
        low.set(parent.id, Math.min(low.get(parent.id) ?? 0, low.get(frame.id) ?? 0))
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = []
        for (;;) {
          const popped = stack.pop()
          if (popped === undefined) break
          onStack.delete(popped)
          component.push(popped)
          if (popped === frame.id) break
        }
        components.push(component)
      }
    }
  }
  return components
}

/** True when a component is a genuine cycle: more than one node, or one node with an edge to itself. */
function isCycle(
  component: readonly string[],
  outgoing: ReadonlyMap<string, readonly { branch: string; to: string }[]>,
): boolean {
  if (component.length > 1) return true
  const only = component[0]
  if (only === undefined) return false
  return (outgoing.get(only) ?? []).some((edge) => edge.to === only)
}

/**
 * The longest accumulated delay from the trigger, over the condensation.
 *
 * Each component's weight is the sum of the delays it contains — once, however many times a cycle could
 * be taken — and the DP runs over the components in topological order, which is `components` reversed.
 */
function longestDelay(
  triggerId: string,
  outgoing: ReadonlyMap<string, readonly { branch: string; to: string }[]>,
  components: readonly (readonly string[])[],
  nodes: ReadonlyMap<string, FlowNode>,
): number {
  const componentOf = new Map<string, number>()
  components.forEach((component, at) => {
    for (const id of component) componentOf.set(id, at)
  })

  const weight = components.map((component) =>
    component.reduce((total, id) => {
      const node = nodes.get(id)
      return node !== undefined && node.kind === 'delay' ? total + node.minutes : total
    }, 0),
  )

  /** The longest delay from the trigger's component to each component. */
  const best = components.map(() => Number.NEGATIVE_INFINITY)
  const start = componentOf.get(triggerId)
  if (start === undefined) return 0
  best[start] = weight[start] ?? 0

  // Topological order: Tarjan emits a component after everything it reaches, so reversing gives an order
  // in which every predecessor is settled before its successors are read.
  for (let at = components.length - 1; at >= 0; at -= 1) {
    const from = best[at]
    if (from === undefined || from === Number.NEGATIVE_INFINITY) continue
    for (const id of components[at] ?? []) {
      for (const edge of outgoing.get(id) ?? []) {
        const target = componentOf.get(edge.to)
        if (target === undefined || target === at) continue
        const candidate = from + (weight[target] ?? 0)
        if (candidate > (best[target] ?? Number.NEGATIVE_INFINITY)) best[target] = candidate
      }
    }
  }

  return best.reduce((max, value) => (value > max ? value : max), 0)
}
