"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";

type StoreCreateFormProps = {
  disabled?: boolean;
};

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function StoreCreateForm({ disabled = false }: StoreCreateFormProps) {
  const router = useRouter();
  const [submitState, setSubmitState] = useState<SubmitState>({ status: "idle" });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitState({ status: "submitting" });

    const formData = new FormData(event.currentTarget);
    const categoryUrls = String(formData.get("categoryUrls") ?? "")
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);

    const response = await fetch("/api/stores", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: formData.get("name"),
        domain: formData.get("domain"),
        sitemapUrl: formData.get("sitemapUrl"),
        feedUrl: formData.get("feedUrl"),
        categoryUrls
      })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setSubmitState({
        status: "error",
        message: payload?.error ?? "Store could not be created"
      });
      return;
    }

    const payload = await response.json();
    setSubmitState({
      status: "success",
      message: `Queued first snapshot ${payload.snapshotId}`
    });
    event.currentTarget.reset();
    router.refresh();
  }

  return (
    <form className="panel form-panel" onSubmit={handleSubmit}>
      <div className="panel-header">
        <div>
          <p className="section-label">Onboarding</p>
          <h2>Add store</h2>
        </div>
      </div>

      <label>
        Store name
        <input
          disabled={disabled}
          name="name"
          placeholder="Example Store"
          required
          type="text"
        />
      </label>

      <label>
        Domain
        <input
          disabled={disabled}
          name="domain"
          placeholder="https://example.com"
          required
          type="url"
        />
      </label>

      <label>
        Sitemap URL
        <input
          disabled={disabled}
          name="sitemapUrl"
          placeholder="https://example.com/sitemap.xml"
          required
          type="url"
        />
      </label>

      <label>
        Product feed URL
        <input
          disabled={disabled}
          name="feedUrl"
          placeholder="https://example.com/google-feed.xml"
          required
          type="url"
        />
      </label>

      <label>
        Critical category URLs
        <textarea
          disabled={disabled}
          name="categoryUrls"
          placeholder={"https://example.com/collections/shoes\nhttps://example.com/collections/bags"}
          required
          rows={5}
        />
      </label>

      <button disabled={disabled || submitState.status === "submitting"} type="submit">
        {submitState.status === "submitting" ? "Creating..." : "Create store"}
      </button>

      {submitState.status === "success" ? (
        <p className="form-message success">{submitState.message}</p>
      ) : null}
      {submitState.status === "error" ? (
        <p className="form-message error">{submitState.message}</p>
      ) : null}
    </form>
  );
}
