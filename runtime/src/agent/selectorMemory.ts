type SelectorRecord = {
  host: string;
  surface: string;
  action: string;
  selector: string;
};

const memory = new Map<string, SelectorRecord>();

function normalizeSurface(url: string): { host: string; surface: string } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.host;
    const pathname = parsed.pathname;

    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 4 && parts[0] === "calendar" && parts[1] === "u" && parts[3] === "r") {
      const surface = `/${parts[0]}/${parts[1]}/${parts[2]}/${parts[3]}`;
      return { host, surface };
    }

    return { host, surface: pathname };
  } catch {
    return null;
  }
}

function key(host: string, surface: string, action: string): string {
  return `${host}:${surface}:${action}`;
}

export function rememberSelector(url: string, action: string, selector: string): void {
  const normalized = normalizeSurface(url);
  if (!normalized) {
    return;
  }

  memory.set(key(normalized.host, normalized.surface, action), {
    host: normalized.host,
    surface: normalized.surface,
    action,
    selector,
  });
}

export function recallSelector(url: string, action: string): string | null {
  const normalized = normalizeSurface(url);
  if (!normalized) {
    return null;
  }

  const record = memory.get(key(normalized.host, normalized.surface, action));
  return record ? record.selector : null;
}

export function clearSelectorMemory(): void {
  memory.clear();
}
