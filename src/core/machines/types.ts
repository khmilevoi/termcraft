/**
 * The `core/machines` module's shared vocabulary: the generic state-machine shapes every
 * one of the seven `reatom*StateMachine` factories is built from (kernel-command-contract
 * §6/§7, `model/state-machine.ts`'s own header comment). Each domain file
 * (`model/project-machine.ts`, `model/turn-machine.ts`, ...) owns its own `Phase`/`Action`
 * union and transition table; this file is only the shared factory vocabulary those seven
 * tables are instances of.
 */
export type {
  StateMachine,
  StateMachineConfig,
  Transition,
  TransitionOutcome,
  TransitionTable,
} from "./model/state-machine"
