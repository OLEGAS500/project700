import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  upsertEmailDestination: vi.fn(),
  upsertTelegramDestination: vi.fn()
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
  upsertEmailDestinationAction,
  upsertTelegramDestinationAction
} from "./actions";

const storeId = "70000000-0000-4000-8000-000000000001";
const initialState = { error: null };

describe("destination server actions", () => {
  beforeEach(() => {
    database.upsertEmailDestination.mockReset();
    database.upsertTelegramDestination.mockReset();
    cache.revalidatePath.mockReset();
    navigation.redirect.mockClear();
  });

  it("rejects duplicate email recipients before calling the database", async () => {
    const result = await upsertEmailDestinationAction(
      storeId,
      initialState,
      formData({
        recipientEmails: "alerts@example.com\nALERTS@example.com",
        emailEnabled: "on"
      })
    );

    expect(result).toEqual({ error: "Enter at least one valid, unique email address." });
    expect(database.upsertEmailDestination).not.toHaveBeenCalled();
  });

  it("normalizes and saves email recipients, then revalidates and redirects", async () => {
    database.upsertEmailDestination.mockResolvedValue({});

    await expect(
      upsertEmailDestinationAction(
        storeId,
        initialState,
        formData({
          recipientEmails: "  Alerts@Example.com  \n ops@example.com ",
          emailEnabled: "on"
        })
      )
    ).rejects.toThrow(`NEXT_REDIRECT:/stores/${storeId}/destinations`);

    expect(database.upsertEmailDestination).toHaveBeenCalledWith(storeId, {
      recipientEmails: ["alerts@example.com", "ops@example.com"],
      enabled: true
    });
    expect(cache.revalidatePath.mock.calls).toEqual([
      [`/stores/${storeId}/destinations`],
      ["/dashboard"]
    ]);
  });

  it("saves Telegram chat, thread, display name, and disabled state", async () => {
    database.upsertTelegramDestination.mockResolvedValue({});

    await expect(
      upsertTelegramDestinationAction(
        storeId,
        initialState,
        formData({
          chatId: "  -1001234567890 ",
          threadId: "42",
          displayName: "  SEO alerts  "
        })
      )
    ).rejects.toThrow(`NEXT_REDIRECT:/stores/${storeId}/destinations`);

    expect(database.upsertTelegramDestination).toHaveBeenCalledWith(storeId, {
      chatId: "-1001234567890",
      threadId: 42,
      displayName: "SEO alerts",
      enabled: false
    });
  });

  it("maps provider or database failures to safe messages", async () => {
    database.upsertTelegramDestination.mockRejectedValue(
      new Error("SQL token https://internal.example -1001234567890")
    );

    const result = await upsertTelegramDestinationAction(
      storeId,
      initialState,
      formData({ chatId: "-1001234567890", threadId: "", displayName: "Alerts", telegramEnabled: "on" })
    );

    expect(result).toEqual({ error: "The Telegram destination could not be saved." });
    expect(result.error).not.toContain("internal.example");
    expect(result.error).not.toContain("-1001234567890");
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(navigation.redirect).not.toHaveBeenCalled();
  });
});

function formData(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.set(name, value);
  return data;
}
