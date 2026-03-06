import type { DomElement } from "./domSnapshot.js";

export type ScoredElement = {
  id: number;
  text: string;
  role?: string;
  score: number;
};

const CREATE_SYNONYMS = [
  "create",
  "new",
  "add",
  "plus",
  "создать",
  "добавить",
  "новый",
  "event",
  "meeting",
  "+",
];

function tokenScore(text: string): number {
  let score = 0;

  for (const word of CREATE_SYNONYMS) {
    if (word === "+") {
      if (text.trim() === "+" || text.includes(" +") || text.includes("+ ")) {
        score += 5;
      }
      continue;
    }

    if (text.includes(word)) {
      score += 5;
    }
  }

  return score;
}

export function scoreCreateButton(elements: ReadonlyArray<DomElement>): ScoredElement[] {
  const scored: ScoredElement[] = [];

  for (const element of elements) {
    let score = 0;

    const text = element.text ?? "";
    const aria = element.aria ?? "";
    const haystack = `${text} ${aria}`.toLowerCase();

    score += tokenScore(haystack);

    const role = element.role?.toLowerCase();
    if (role === "button") {
      score += 2;
    }

    if (element.tag === "button") {
      score += 2;
    }

    if (score > 0) {
      scored.push({
        id: element.id,
        text: text || aria || "(untitled)",
        role,
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function hasCreateIntent(command: string): boolean {
  return /\b(create|new|meeting|event|add)\b|созда|добав|встреч|событ/i.test(command);
}
