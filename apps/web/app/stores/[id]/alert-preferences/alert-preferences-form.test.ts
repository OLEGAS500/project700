import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./actions", () => ({ updateAlertPreferencesAction: vi.fn() }));

import { defaultAlertPreferences } from "@eim/core";
import AlertPreferencesForm from "./alert-preferences-form";

describe("alert preferences form", () => {
  it("renders current channels, lifecycle controls, and muted incident types", () => {
    const html = renderToStaticMarkup(
      createElement(AlertPreferencesForm, {
        storeId: "70000000-0000-4000-8000-000000000001",
        record: { preferences: defaultAlertPreferences }
      })
    );

    expect(html).toContain('name="enabled"');
    expect(html).toContain('name="emailEnabled" checked=""');
    expect(html).toContain('name="telegramEnabled"');
    expect(html).toContain('name="notifyOnOpen" checked=""');
    expect(html).toContain('name="notifyOnRecovery"');
    expect(html).toContain('name="worseningAffectedCountPercent" value="20"');
    expect(html).toContain('name="mutedIncidentTypes" value="source_health"');
    expect(html).toContain("Save preferences");
  });

  it("round-trips precise worsening thresholds without floating-point display artifacts", () => {
    const html = renderToStaticMarkup(
      createElement(AlertPreferencesForm, {
        storeId: "70000000-0000-4000-8000-000000000001",
        record: {
          preferences: {
            ...defaultAlertPreferences,
            worseningAffectedCountPercent: 0.33333
          }
        }
      })
    );

    expect(html).toContain('name="worseningAffectedCountPercent" value="33.333"');
    expect(html).toContain('step="any"');
  });
});
