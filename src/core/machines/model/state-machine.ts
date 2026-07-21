import { atom, type Atom } from "@reatom/core"

import type { CommandRejectionCode } from "core/protocol"

/**
 * The shared mechanism behind the seven Reatom state machines
 * (kernel-command-contract §6/§7).
 *
 * §6 fixes the shape all seven share: "Kernel legality is expressed by explicit named
 * Reatom v1001 state-machine models and named transition actions. The legal source
 * states, targets, and rejection codes are table-driven and testable." And: "Any
 * source/action pair not listed in the following tables is illegal and returns the
 * table's domain rejection code without changing state."
 *
 * So the table IS the specification, transcribed once per domain, and this factory is the
 * only thing that interprets it. Seven hand-written machines would be seven chances to
 * mis-handle an unlisted pair; §13.1 demands every state/action pair be enumerated in
 * tests, and that is only meaningful if a single implementation decides them all.
 */

/** One legal edge: a source phase, its target, and whether it counts as a real change. */
export interface Transition<Phase extends string> {
  readonly from: Phase
  readonly to: Phase
  /**
   * A same-state edge that §13.1 classifies as "an explicit no-op" rather than "a real
   * revision-changing update". It is legal, but it must not advance `stateRevision`
   * (§4: only "each atomic authoritative Kernel state transition" does).
   */
  readonly noOp?: boolean
}

/** Every named action of one domain, mapped to the edges that action may take. */
export type TransitionTable<Phase extends string, Action extends string> = Readonly<
  Record<Action, readonly Transition<Phase>[]>
>

/** What applying an action did. */
export type TransitionOutcome<Phase extends string, Action extends string> =
  | { readonly kind: "changed"; readonly from: Phase; readonly to: Phase }
  | { readonly kind: "no-op"; readonly phase: Phase }
  | {
      readonly kind: "illegal"
      readonly code: CommandRejectionCode
      readonly from: Phase
      readonly action: Action
    }

export interface StateMachineConfig<Phase extends string, Action extends string> {
  /** The `kernel.<domain>` trace root §6's factory table fixes. */
  readonly traceRoot: string
  readonly initial: Phase
  readonly table: TransitionTable<Phase, Action>
  /** The rejection code an unlisted (source, action) pair returns for this domain. */
  readonly illegalCode: CommandRejectionCode
}

export interface StateMachine<Phase extends string, Action extends string> {
  readonly phase: () => Phase
  readonly phaseAtom: Atom<Phase>
  /** Applies a named action, moving the machine only if the pair is listed. */
  readonly apply: (action: Action) => TransitionOutcome<Phase, Action>
  /** Whether the action is legal from the current phase — a pure read, no transition. */
  readonly canApply: (action: Action) => boolean
}

/**
 * Builds one domain's machine. A factory, not module-level atoms: §5 scopes the models to
 * one "Kernel Reatom context", and module-level state would let two kernels — or two
 * tests — share a phase and invalidate each other.
 */
export function createStateMachine<Phase extends string, Action extends string>(
  config: StateMachineConfig<Phase, Action>,
): StateMachine<Phase, Action> {
  const phaseAtom = atom<Phase>(config.initial, `${config.traceRoot}.state`)

  function edgeFor(action: Action, from: Phase): Transition<Phase> | null {
    const edges = config.table[action]
    if (edges === undefined) return null
    return edges.find((edge) => edge.from === from) ?? null
  }

  function apply(action: Action): TransitionOutcome<Phase, Action> {
    const from = phaseAtom()
    const edge = edgeFor(action, from)
    if (edge === null) {
      // §6: an unlisted pair "is illegal and returns the table's domain rejection code
      // WITHOUT CHANGING STATE" — so this branch deliberately touches no atom.
      return { kind: "illegal", code: config.illegalCode, from, action }
    }

    if (edge.noOp === true) {
      // Legal, but explicitly not a state change: the caller must not advance the
      // revision for it (§4/§13.1).
      return { kind: "no-op", phase: from }
    }

    phaseAtom.set(edge.to)
    return { kind: "changed", from, to: edge.to }
  }

  function canApply(action: Action): boolean {
    return edgeFor(action, phaseAtom()) !== null
  }

  return {
    phase: () => phaseAtom(),
    phaseAtom,
    apply,
    canApply,
  }
}
