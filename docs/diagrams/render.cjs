const { chromium } = require(require("node:path").resolve(process.argv[2]));
const fs = require("node:fs"),
  path = require("node:path");
const [, , , mmdPath, outDir] = process.argv;
const src = fs.readFileSync(mmdPath, "utf8");
const themes = {
  light: {
    bg: "#ffffff",
    vars: {
      primaryColor: "#eef0ff",
      primaryBorderColor: "#6b72e6",
      primaryTextColor: "#14151a",
      lineColor: "#5b5f6e",
      secondaryColor: "#f4f5f8",
      tertiaryColor: "#ffffff",
      edgeLabelBackground: "#ffffff",
      fontFamily: "Inter, Segoe UI, Arial, sans-serif",
      fontSize: "16px",
    },
  },
  dark: {
    bg: "#0d0e12",
    vars: {
      darkMode: true,
      background: "#0d0e12",
      primaryColor: "#1a1c26",
      primaryBorderColor: "#9aa0ff",
      primaryTextColor: "#e8e9ee",
      lineColor: "#8b8fa0",
      secondaryColor: "#14151c",
      tertiaryColor: "#0d0e12",
      edgeLabelBackground: "#0d0e12",
      fontFamily: "Inter, Segoe UI, Arial, sans-serif",
      fontSize: "16px",
    },
  },
};
(async () => {
  const browser = await chromium.launch();
  for (const [name, t] of Object.entries(themes)) {
    const page = await browser.newPage({
      deviceScaleFactor: 3,
      viewport: { width: 2400, height: 2400 },
    });
    await page.setContent(`<html><body style="margin:0;background:${t.bg}"><div id="d" style="display:inline-block;padding:32px;background:${t.bg}"></div>
      <script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script></body></html>`);
    await page.waitForFunction(() => window.mermaid);
    const svg = await page.evaluate(
      async ({ src, vars }) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: "base",
          themeVariables: vars,
          flowchart: { curve: "basis", padding: 16 },
        });
        const { svg } = await mermaid.render("g", src);
        document.getElementById("d").innerHTML = svg;
        const el = document.querySelector("#d svg");
        const vb = el.viewBox.baseVal;
        el.style.maxWidth = "none";
        el.setAttribute("width", vb.width);
        el.setAttribute("height", vb.height);
        return svg;
      },
      { src, vars: t.vars },
    );
    await page.waitForTimeout(300);
    await page
      .locator("#d")
      .screenshot({ path: path.join(outDir, `agent-memory-flow-${name}.png`) });
    // Biome lints SVGs: drop Mermaid's redundant role and give the drawing a title.
    const clean = svg
      .replace(' role="graphics-document document"', "")
      .replace(/(<svg[^>]*>)/, "$1<title>How Rehearsal uses SurrealDB Agent Memory</title>");
    fs.writeFileSync(path.join(outDir, `agent-memory-flow-${name}.svg`), clean);
    await page.close();
  }
  await browser.close();
})();
