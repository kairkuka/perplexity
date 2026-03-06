import { beforeEach, describe, expect, it } from "vitest";

import { clearSelectorMemory, recallSelector, rememberSelector } from "../agent/selectorMemory.js";

describe("selectorMemory", () => {
  beforeEach(() => {
    clearSelectorMemory();
  });

  it("stores and recalls selectors by host+surface+action", () => {
    rememberSelector("https://calendar.google.com/calendar/u/0/r", "create", "[data-agent-id=\"26\"]");

    expect(recallSelector("https://calendar.google.com/calendar/u/0/r", "create")).toBe("[data-agent-id=\"26\"]");
    expect(recallSelector("https://calendar.google.com/calendar/u/0/r/tasks", "create")).toBeNull();
    expect(recallSelector("https://calendar.google.com/calendar/u/1/r", "create")).toBeNull();
  });
});
