import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const actionStubs = vi.hoisted(() => ({
  acknowledgeIncidentAction: vi.fn(),
  addIncidentCommentAction: vi.fn(),
  ignoreIncidentAction: vi.fn()
}));

vi.mock("./actions", () => actionStubs);

import IncidentActions from "./incident-actions";

describe("incident actions form", () => {
  it("shows the allowed actions and validation limits for an open incident", () => {
    const html = renderToStaticMarkup(
      createElement(IncidentActions, {
        incidentId: "70000000-0000-4000-8000-000000000001",
        status: "open"
      })
    );

    expect(html).toContain("Acknowledge incident");
    expect(html).toContain("Ignore incident");
    expect(html).toContain("Add comment");
    expect(html).toContain('name="reason"');
    expect(html).toContain('name="body"');
    expect(html).toContain('maxLength="120"');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain('maxLength="4000"');
  });

  it("hides acknowledge and ignore after the incident is resolved", () => {
    const html = renderToStaticMarkup(
      createElement(IncidentActions, {
        incidentId: "70000000-0000-4000-8000-000000000001",
        status: "resolved"
      })
    );

    expect(html).not.toContain("Acknowledge incident");
    expect(html).not.toContain("Ignore incident");
    expect(html).toContain("Add comment");
  });
});
