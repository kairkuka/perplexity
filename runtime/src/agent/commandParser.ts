import type { Plan, Step } from "./steps.js";

function normalizeUrl(raw: string): string {
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return `https://${raw}`;
}

function extractUrl(command: string): string | null {
  const fullMatch = command.match(/https?:\/\/[^\s]+/i);
  if (fullMatch?.[0]) {
    return fullMatch[0];
  }

  const domainMatch = command.match(/\b([a-z0-9-]+\.)+[a-z]{2,}\b/i);
  if (!domainMatch?.[0]) {
    return null;
  }

  return normalizeUrl(domainMatch[0]);
}

function cleanupQuery(query: string): string {
  return query
    .replace(/\s+(and\s+click.*|и\s+кликни.*)$/i, "")
    .replace(/^['"“”]|['"“”]$/g, "")
    .replace(/[.!?]+$/, "")
    .trim();
}

function extractSearchQuery(command: string): string | null {
  const quoted = command.match(/["“']([^"”']+)["”']/);
  if (quoted?.[1]) {
    return cleanupQuery(quoted[1]);
  }

  const russian = command.match(/найди\s+(.+)$/i);
  if (russian?.[1]) {
    return cleanupQuery(russian[1]);
  }

  const english = command.match(/search(?:\s+for)?\s+(.+)$/i);
  if (english?.[1]) {
    return cleanupQuery(english[1]);
  }

  return null;
}

function hasSearchIntent(command: string): boolean {
  return /\bsearch\b|найди/i.test(command);
}

function hasClickFirstIntent(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.includes("first result") || (lower.includes("перв") && lower.includes("результ"));
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseLegacySearchCommand(command: string): Step[] {
  const steps: Step[] = [];
  const url = extractUrl(command);
  const searchIntent = hasSearchIntent(command);
  const clickFirstIntent = hasClickFirstIntent(command);

  if (url) {
    steps.push({
      type: "OPEN_URL",
      url,
      timeoutMs: 30000,
    });
  }

  if (searchIntent) {
    const query = extractSearchQuery(command) ?? "Blink Desktop";
    steps.push({
      type: "GOOGLE_SEARCH",
      query,
      timeoutMs: 20000,
    });
  }

  if (clickFirstIntent) {
    steps.push({
      type: "CLICK_FIRST_RESULT",
      timeoutMs: 15000,
    });
  }

  return steps;
}

function parseSegment(segment: string): Step[] {
  const c = segment.trim();
  const lower = c.toLowerCase();

  if (!c) {
    return [];
  }

  if (lower.startsWith("open ")) {
    const rawUrl = c.slice(5).trim();
    const url = normalizeUrl(rawUrl);
    return [{ type: "OPEN_URL", url }];
  }

  if (lower.startsWith("extract ")) {
    const rest = c.slice(8).trim();
    const match = rest.match(/^(url|title|text)(?:\s+selector\s+(.+))?$/i);
    if (!match) {
      throw new Error("Bad extract syntax");
    }

    const kind = match[1].toLowerCase() as "url" | "title" | "text";
    const selector = match[2] ? stripQuotes(match[2]) : undefined;

    return [{
      type: "EXTRACT",
      kind,
      selector,
    }];
  }

  if (lower.startsWith("wait selector ")) {
    const selector = stripQuotes(c.slice("wait selector ".length));
    return [{ type: "WAIT_FOR_SELECTOR", selector }];
  }

  if (lower === "wait navigation") {
    return [{ type: "WAIT_NAVIGATION" }];
  }

  if (lower === "snapshot") {
    return [{ type: "SNAPSHOT" }];
  }

  if (lower === "create new event" || lower === "create event") {
    return [
      { type: "CLICK", text: "Create", mode: "fuzzy" },
      { type: "CLICK", text: "Event", mode: "fuzzy" },
    ];
  }

  if (lower.startsWith("set date ")) {
    const date = stripQuotes(c.slice("set date ".length));
    if (!date) {
      throw new Error("Bad set date syntax");
    }
    return [{ type: "SET_EVENT_DATE", date }];
  }

  if (lower.startsWith("set start ")) {
    const time = stripQuotes(c.slice("set start ".length));
    if (!time) {
      throw new Error("Bad set start syntax");
    }
    return [{ type: "SET_EVENT_START", time }];
  }

  if (lower.startsWith("set end ")) {
    const time = stripQuotes(c.slice("set end ".length));
    if (!time) {
      throw new Error("Bad set end syntax");
    }
    return [{ type: "SET_EVENT_END", time }];
  }

  if (lower === "save") {
    return [{ type: "SAVE_EVENT" }];
  }

  if (lower.startsWith("click selector ")) {
    const selector = stripQuotes(c.slice("click selector ".length));
    return [{ type: "CLICK", selector }];
  }

  if (lower.startsWith("click fuzzy ")) {
    const text = stripQuotes(c.slice("click fuzzy ".length));
    return [{ type: "CLICK", text, mode: "fuzzy" }];
  }

  if (lower.startsWith("click ")) {
    const text = stripQuotes(c.slice(6));
    return [{ type: "CLICK", text, mode: "strict" }];
  }

  if (lower.startsWith("type ")) {
    const simpleText = c.match(/^type\s+(.+)$/i);
    if (simpleText && !/\s+into\s+/i.test(c)) {
      const text = stripQuotes(simpleText[1]);
      return [{ type: "TYPE", text, selector: ":focus" }];
    }

    const match = c.match(/^type\s+(.+?)\s+into\s+(label|placeholder|selector)\s+(.+)$/i);
    if (!match) {
      throw new Error("Bad type syntax");
    }

    const text = stripQuotes(match[1]);
    const kind = match[2].toLowerCase();
    const target = stripQuotes(match[3]);

    if (kind === "label") {
      return [{ type: "TYPE", text, label: target }];
    }

    if (kind === "placeholder") {
      return [{ type: "TYPE", text, placeholder: target }];
    }

    return [{ type: "TYPE", text, selector: target }];
  }

  if (lower.startsWith("press ")) {
    const key = stripQuotes(c.slice(6));
    return [{ type: "PRESS", key }];
  }

  if (lower.startsWith("scroll ")) {
    const value = Number(c.slice(7).trim());
    if (Number.isNaN(value)) {
      throw new Error("Bad scroll syntax");
    }
    return [{ type: "SCROLL", deltaY: value }];
  }

  const legacy = parseLegacySearchCommand(c);
  if (legacy.length > 0) {
    return legacy;
  }

  throw new Error("Unknown command syntax");
}

export function parseCommandToSteps(command: string): Step[] {
  const normalized = command.trim();
  const segments = normalized
    .split(/\n+|;/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new Error("Unknown command syntax");
  }

  return segments.flatMap((segment) => parseSegment(segment));
}

export function parseCommand(command: string): Plan {
  const normalized = command.trim();
  const steps = parseCommandToSteps(normalized);

  if (steps.length === 0) {
    throw new Error("Unknown command syntax");
  }

  return {
    rawCommand: normalized,
    steps,
  };
}
