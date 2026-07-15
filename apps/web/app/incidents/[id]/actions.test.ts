import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  acknowledgeIncident: vi.fn(),
  addIncidentComment: vi.fn(),
  ignoreIncident: vi.fn(),
  IncidentActionConflictError: class IncidentActionConflictError extends Error {},
  IncidentNotFoundError: class IncidentNotFoundError extends Error {}
}));

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
const navigation = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  })
}));

vi.mock("@eim/db", () => database);
vi.mock("next/cache", () => cache);
vi.mock("next/navigation", () => navigation);

import {
  acknowledgeIncidentAction,
  addIncidentCommentAction,
  ignoreIncidentAction
} from "./actions";

const incidentId = "70000000-0000-4000-8000-000000000001";
const initialState = { error: null };

describe("incident server actions", () => {
  beforeEach(() => {
    database.acknowledgeIncident.mockReset();
    database.addIncidentComment.mockReset();
    database.ignoreIncident.mockReset();
    cache.revalidatePath.mockReset();
    navigation.redirect.mockClear();
  });

  it("rejects invalid input before calling the database", async () => {
    const result = await ignoreIncidentAction(incidentId, initialState, formData({ reason: " " }));

    expect(result).toEqual({ error: "Enter your name and a reason before ignoring this incident." });
    expect(database.ignoreIncident).not.toHaveBeenCalled();
  });

  it("trims acknowledge fields and invalidates all affected views before redirect", async () => {
    database.acknowledgeIncident.mockResolvedValue({});

    await expect(
      acknowledgeIncidentAction(
        incidentId,
        initialState,
        formData({ actor: "  Oleg  ", comment: "  Investigating  " })
      )
    ).rejects.toThrow(`NEXT_REDIRECT:/incidents/${incidentId}`);

    expect(database.acknowledgeIncident).toHaveBeenCalledWith(incidentId, {
      actor: "Oleg",
      comment: "Investigating"
    });
    expect(cache.revalidatePath.mock.calls).toEqual([
      [`/incidents/${incidentId}`],
      ["/incidents"],
      ["/dashboard"]
    ]);
  });

  it("trims ignore fields and invalidates all affected views", async () => {
    database.ignoreIncident.mockResolvedValue({});

    await expect(
      ignoreIncidentAction(
        incidentId,
        initialState,
        formData({ actor: "  Oleg  ", reason: "  Planned maintenance  " })
      )
    ).rejects.toThrow(`NEXT_REDIRECT:/incidents/${incidentId}`);

    expect(database.ignoreIncident).toHaveBeenCalledWith(incidentId, {
      actor: "Oleg",
      reason: "Planned maintenance"
    });
    expect(cache.revalidatePath.mock.calls).toEqual([
      [`/incidents/${incidentId}`],
      ["/incidents"],
      ["/dashboard"]
    ]);
  });

  it("trims comment fields and invalidates only the detail view", async () => {
    database.addIncidentComment.mockResolvedValue({});

    await expect(
      addIncidentCommentAction(
        incidentId,
        initialState,
        formData({ actor: "  Oleg  ", body: "  Context added  " })
      )
    ).rejects.toThrow(`NEXT_REDIRECT:/incidents/${incidentId}`);

    expect(database.addIncidentComment).toHaveBeenCalledWith(incidentId, {
      actor: "Oleg",
      body: "Context added"
    });
    expect(cache.revalidatePath.mock.calls).toEqual([[`/incidents/${incidentId}`]]);
  });

  it.each([
    ["conflict", () => new database.IncidentActionConflictError("conflict")],
    ["not-found", () => new database.IncidentNotFoundError("not-found")]
  ])("maps %s errors to safe messages", async (_name, createError) => {
    database.ignoreIncident.mockRejectedValue(createError());

    const result = await ignoreIncidentAction(
      incidentId,
      initialState,
      formData({ actor: "Oleg", reason: "Reason" })
    );

    expect(result.error).toMatch(/status changed|no longer exists/);
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });

  it("does not expose a generic database error", async () => {
    database.addIncidentComment.mockRejectedValue(
      new Error("SQL SELECT secret@example.com https://internal.example/incident")
    );

    const result = await addIncidentCommentAction(
      incidentId,
      initialState,
      formData({ actor: "Oleg", body: "Comment" })
    );

    expect(result).toEqual({ error: "The comment could not be added." });
    expect(result.error).not.toContain("secret@example.com");
    expect(result.error).not.toContain("internal.example");
    expect(cache.revalidatePath).not.toHaveBeenCalled();
  });
});

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}
