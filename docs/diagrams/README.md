# Diagrams

`agent-memory-flow` is the Agent Memory diagram from [`docs/surrealdb-writeup.md`](../surrealdb-writeup.md), rendered for places that can't draw Mermaid (the SurrealDB blog, slides).

| File | Use |
|---|---|
| `agent-memory-flow-light.png`, `-dark.png` | Top to bottom, 3× scale, for a blog column or a doc |
| `agent-memory-flow-light.svg`, `-dark.svg` | The same, as vectors |
| `agent-memory-flow-wide-light.png` | Left to right, for a slide or a header |
| `agent-memory-flow.mmd` | The source |

To re-render after editing the `.mmd` (keep the copy in the write-up in step):

```bash
node docs/diagrams/render.cjs node_modules/.pnpm/playwright@1.64.1/node_modules/playwright docs/diagrams/agent-memory-flow.mmd docs/diagrams
```

It uses the repo's Playwright Chromium and loads Mermaid 11.4.1 from jsDelivr, so it needs network access. It writes the light and dark PNG and SVG; render a copy with `flowchart LR` for the wide one.
