import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProcessDiagram } from "../src/components/ProcessDiagram";

const html = (active?: 1 | 2 | 3 | 4 | 5) =>
  renderToStaticMarkup(<ProcessDiagram active={active} />);

describe("ProcessDiagram", () => {
  it("reads the five steps in order and highlights nothing by default", () => {
    const markup = html();
    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      "Copy, Plan, Approve, Apply, Receipts. Copy and Plan are the planning world. Approve is the gate. Apply and Receipts are the operational world.",
    );
    expect(markup).not.toContain("Current step");
    expect(markup).not.toContain("data-current");
    expect(markup).not.toContain("var(--lime)");
  });

  it("marks only the active step, in both layouts", () => {
    const markup = html(3);
    expect(markup).toContain("Current step 3, Approve.");
    expect(markup.match(/data-step="3" data-current="true"/g)).toHaveLength(2);
    expect(markup).not.toContain('data-step="1" data-current');
    expect(markup).not.toContain('data-step="4" data-current');
  });
});
