import { describe, expect, it } from "vitest";

import { requiresApproval } from "../safety/safetyGate.js";
import type { Step } from "../agent/steps.js";

describe("requiresApproval", () => {
  it("allows OPEN_URL for allowlisted domains", () => {
    const step: Step = { type: "OPEN_URL", url: "https://example.com" };
    expect(requiresApproval(step)).toBe(false);
  });

  it("blocks OPEN_URL for non-allowlisted domains", () => {
    const step: Step = { type: "OPEN_URL", url: "https://not-allowed.test" };
    expect(requiresApproval(step)).toBe(true);
  });

  it("blocks TYPE on sensitive selector", () => {
    const step: Step = {
      type: "TYPE",
      text: "secret",
      selector: "input[name=password]",
    };
    expect(requiresApproval(step)).toBe(true);
  });

  it("allows TYPE on non-sensitive selector", () => {
    const step: Step = {
      type: "TYPE",
      text: "blink",
      selector: "input[name=query]",
    };
    expect(requiresApproval(step)).toBe(false);
  });
});
