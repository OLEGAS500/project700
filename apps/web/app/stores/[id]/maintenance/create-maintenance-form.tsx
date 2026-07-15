"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { createMaintenanceWindowAction, type MaintenanceActionState } from "./actions";

export default function CreateMaintenanceForm({ storeId }: { storeId: string }) {
  const initial: MaintenanceActionState = { error: null };
  const [state, action] = useActionState(
    (previous: MaintenanceActionState, formData: FormData) =>
      createMaintenanceWindowAction(storeId, previous, formData),
    initial
  );
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");

  return (
    <form action={action} className="maintenance-create-form">
      <label>
        <span>Start</span>
        <input type="datetime-local" required value={startsAt} onChange={(event) => setStartsAt(event.target.value)} />
        <input type="hidden" name="startsAt" value={toIso(startsAt)} />
      </label>
      <label>
        <span>End</span>
        <input type="datetime-local" required value={endsAt} onChange={(event) => setEndsAt(event.target.value)} />
        <input type="hidden" name="endsAt" value={toIso(endsAt)} />
      </label>
      <label>
        <span>Reason</span>
        <textarea name="reason" required maxLength={2000} rows={3} />
      </label>
      <label>
        <span>Created by</span>
        <input name="createdBy" required maxLength={120} autoComplete="name" />
      </label>
      <SubmitButton label="Create maintenance window" />
      {state.error ? <p className="maintenance-action-error" role="alert">{state.error}</p> : null}
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? "Saving..." : label}</button>;
}

function toIso(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
