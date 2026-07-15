"use client";

import type { EmailDestinationRecord, TelegramDestinationRecord } from "@eim/db";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  type DestinationActionState,
  upsertEmailDestinationAction,
  upsertTelegramDestinationAction
} from "./actions";

export function EmailDestinationForm({
  storeId,
  destination
}: {
  storeId: string;
  destination: EmailDestinationRecord | null;
}) {
  const initialState: DestinationActionState = { error: null };
  const [state, action] = useActionState(
    (previousState: DestinationActionState, formData: FormData) =>
      upsertEmailDestinationAction(storeId, previousState, formData),
    initialState
  );

  return (
    <form action={action} className="destination-form">
      <label className="destination-field">
        <span>Recipient emails</span>
        <textarea
          name="recipientEmails"
          defaultValue={destination?.recipientEmails.join("\n") ?? ""}
          placeholder="alerts@example.com"
          rows={5}
          maxLength={6_419}
          required
          aria-describedby="email-recipient-help"
        />
        <em id="email-recipient-help">One address per line, up to 20 recipients.</em>
      </label>
      <DestinationToggle
        name="emailEnabled"
        label="Email destination enabled"
        description="Allow eligible alerts to create email deliveries."
        defaultChecked={destination?.enabled ?? false}
      />
      <DestinationStatus destination={destination} kind="email" />
      <DestinationSubmit label="Save email destination" pendingLabel="Saving email destination..." />
      {state.error ? <p className="destination-action-error" role="alert">{state.error}</p> : null}
    </form>
  );
}

export function TelegramDestinationForm({
  storeId,
  destination
}: {
  storeId: string;
  destination: TelegramDestinationRecord | null;
}) {
  const initialState: DestinationActionState = { error: null };
  const [state, action] = useActionState(
    (previousState: DestinationActionState, formData: FormData) =>
      upsertTelegramDestinationAction(storeId, previousState, formData),
    initialState
  );

  return (
    <form action={action} className="destination-form">
      <label className="destination-field">
        <span>Chat ID</span>
        <input name="chatId" defaultValue={destination?.chatId ?? ""} maxLength={128} required />
        <em>Stored as a destination address; the bot token stays in the runtime environment.</em>
      </label>
      <div className="destination-field-grid">
        <label className="destination-field">
          <span>Thread ID <small>optional</small></span>
          <input
            type="number"
            name="threadId"
            defaultValue={destination?.threadId ?? ""}
            min="1"
            step="1"
          />
        </label>
        <label className="destination-field">
          <span>Display name <small>optional</small></span>
          <input name="displayName" defaultValue={destination?.displayName ?? ""} maxLength={120} />
        </label>
      </div>
      <DestinationToggle
        name="telegramEnabled"
        label="Telegram destination enabled"
        description="Allow eligible alerts to create Telegram deliveries."
        defaultChecked={destination?.enabled ?? false}
      />
      <DestinationStatus destination={destination} kind="telegram" />
      <DestinationSubmit label="Save Telegram destination" pendingLabel="Saving Telegram destination..." />
      {state.error ? <p className="destination-action-error" role="alert">{state.error}</p> : null}
    </form>
  );
}

function DestinationToggle({
  name,
  label,
  description,
  defaultChecked
}: {
  name: string;
  label: string;
  description: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="destination-toggle">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} />
      <span>
        <strong>{label}</strong>
        <em>{description}</em>
      </span>
    </label>
  );
}

function DestinationStatus({
  destination,
  kind
}: {
  destination: EmailDestinationRecord | TelegramDestinationRecord | null;
  kind: "email" | "telegram";
}) {
  if (!destination) {
    return <p className="destination-status destination-status-neutral">Not configured</p>;
  }

  const verified = kind === "telegram" && "verifiedAt" in destination && destination.verifiedAt;

  return (
    <p className={`destination-status ${destination.enabled ? "destination-status-enabled" : "destination-status-disabled"}`}>
      {destination.enabled ? "Enabled" : "Disabled"}
      {verified ? " · Verified" : null}
    </p>
  );
}

function DestinationSubmit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? pendingLabel : label}</button>;
}
