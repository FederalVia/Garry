/**
 * Inference budget
 *
 * Budgets are enforced by the process-wide InferenceGate (gate.ts) against
 * the inference_ledger, with the caps resolved in policy.ts. This module
 * keeps the old import path working.
 */

export {
  InferenceGate,
  installInferenceGate,
  getInstalledInferenceGate,
  requireInferenceGate,
  runWithInferenceScope,
  currentInferenceScope,
  budgetClassFor,
  type InferenceScope,
  type InferenceCaller,
  type InferenceUsageReport,
  type Reservation,
  type ReserveRequest,
} from "./gate.js";
export {
  resolveInferencePolicy,
  registryPrice,
  effectivePrice,
  type ResolvedInferencePolicy,
  type ModelPrice,
} from "./policy.js";
export { InferenceRefusedError, type RefusalCode, type BudgetClass } from "./errors.js";
