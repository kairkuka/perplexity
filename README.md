# Blink Desktop Web Agent (MVP-0/MVP-1 baseline)

This repository contains a browser-first local agent split into three packages:

- `shared`: typed WebSocket protocol + zod validation.
- `runtime`: local Node.js runtime that controls Chrome via Playwright.
- `web`: React UI that sends commands and shows live frames/logs.

## Run

1. Install dependencies:

```bash
npm install
```

2. Start runtime:

```bash
npm run dev:runtime
```

3. Start web UI:

```bash
npm run dev:web
```

4. Open [http://localhost:5173](http://localhost:5173), use command input and click **Run**.

## Example commands

- `open https://example.com`
- `Open https://example.com and take a screenshot`
- `Открой google.com и найди Blink Desktop`

## Protocol

- UI -> Runtime: `RUN`, `PAUSE`, `RESUME`, `STOP`, `APPROVE`, `REJECT`
- Runtime -> UI: `STATE`, `FRAME`, `LOG`, `NEED_APPROVAL`, `ERROR`

Runtime listens on `ws://localhost:8787` (bound to `127.0.0.1` by default).

## Verification

```bash
npm run typecheck
npm run test
npm -w web run build
```
