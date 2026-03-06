import { describe, expect, it } from "vitest";

import type { DomElement } from "../agent/domSnapshot.js";
import { hasCreateIntent, scoreCreateButton } from "../agent/elementScoring.js";

describe("elementScoring", () => {
  it("ranks create-like button labels ahead of generic items", () => {
    const elements: DomElement[] = [
      { id: 1, tag: "a", text: "Settings" },
      { id: 2, tag: "button", text: "Create event", role: "button" },
      { id: 3, tag: "button", text: "Создать", role: "button" },
    ];

    const scored = scoreCreateButton(elements);

    expect(scored.length).toBeGreaterThanOrEqual(2);
    expect(scored[0]?.id).toBe(2);
    expect(scored[1]?.id).toBe(3);
    expect(scored.every((item) => item.score > 0)).toBe(true);
  });

  it("detects create intent in different languages", () => {
    expect(hasCreateIntent("create a new meeting")).toBe(true);
    expect(hasCreateIntent("создать событие в календаре")).toBe(true);
    expect(hasCreateIntent("open pricing page")).toBe(false);
  });
});
