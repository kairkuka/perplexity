import { describe, expect, it } from "vitest";

import { parseCommand, parseCommandToSteps } from "../agent/commandParser.js";

describe("parseCommand", () => {
  it("parses english search + click command to GOOGLE_SEARCH + CLICK_FIRST_RESULT", () => {
    const plan = parseCommand("Search for Blink Desktop and click the first result");

    expect(plan.steps).toMatchObject([
      { type: "GOOGLE_SEARCH", query: "Blink Desktop" },
      { type: "CLICK_FIRST_RESULT" },
    ]);
  });

  it("parses russian open+search command to OPEN_URL + GOOGLE_SEARCH", () => {
    const plan = parseCommand("Открой google.com и найди Blink Desktop");

    expect(plan.steps).toMatchObject([
      { type: "OPEN_URL", url: "https://google.com" },
      { type: "GOOGLE_SEARCH", query: "Blink Desktop" },
    ]);
  });

  it("parses open and extract pipeline with semicolon", () => {
    const steps = parseCommandToSteps("open https://example.com; extract title");

    expect(steps).toMatchObject([
      { type: "OPEN_URL", url: "https://example.com" },
      { type: "EXTRACT", kind: "title" },
    ]);
  });

  it("parses click selector", () => {
    const steps = parseCommandToSteps('click selector "a[href*=iana]"');

    expect(steps).toMatchObject([
      { type: "CLICK", selector: "a[href*=iana]" },
    ]);
  });

  it("parses click strict and fuzzy", () => {
    const strict = parseCommandToSteps('click "Learn more"');
    const fuzzy = parseCommandToSteps('click fuzzy "More information"');

    expect(strict).toMatchObject([{ type: "CLICK", text: "Learn more", mode: "strict" }]);
    expect(fuzzy).toMatchObject([{ type: "CLICK", text: "More information", mode: "fuzzy" }]);
  });

  it("parses type into label", () => {
    const steps = parseCommandToSteps('type "hello" into label "Email"');

    expect(steps).toMatchObject([
      { type: "TYPE", text: "hello", label: "Email" },
    ]);
  });

  it("parses simple type command to focused target", () => {
    const steps = parseCommandToSteps("type 'чйотам'");

    expect(steps).toMatchObject([
      { type: "TYPE", text: "чйотам", selector: ":focus" },
    ]);
  });

  it("parses press, scroll and wait navigation", () => {
    const steps = parseCommandToSteps('press "Enter"; scroll 800; wait navigation');

    expect(steps).toMatchObject([
      { type: "PRESS", key: "Enter" },
      { type: "SCROLL", deltaY: 800 },
      { type: "WAIT_NAVIGATION" },
    ]);
  });

  it("parses snapshot step", () => {
    const steps = parseCommandToSteps("snapshot");

    expect(steps).toMatchObject([
      { type: "SNAPSHOT" },
    ]);
  });

  it("parses calendar explicit date/time/save DSL", () => {
    const steps = parseCommandToSteps("set date 2026-03-05; set start 11:00; set end 12:00; save");

    expect(steps).toMatchObject([
      { type: "SET_EVENT_DATE", date: "2026-03-05" },
      { type: "SET_EVENT_START", time: "11:00" },
      { type: "SET_EVENT_END", time: "12:00" },
      { type: "SAVE_EVENT" },
    ]);
  });

  it("throws on unsupported command", () => {
    expect(() => parseCommand("do something unknown")).toThrowError("Unknown command syntax");
  });
});
