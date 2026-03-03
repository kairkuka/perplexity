import type { Step } from "../agent/steps.js";

export function requiresApproval(_step: Step): boolean {
  return false;
}
