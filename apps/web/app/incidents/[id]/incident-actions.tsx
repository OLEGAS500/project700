"use client";

import type { IncidentStatus } from "@eim/core";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  acknowledgeIncidentAction,
  addIncidentCommentAction,
  ignoreIncidentAction,
  type IncidentActionState
} from "./actions";

type IncidentActionsProps = {
  incidentId: string;
  status: IncidentStatus;
};

export default function IncidentActions({ incidentId, status }: IncidentActionsProps) {
  const initialActionState: IncidentActionState = { error: null };
  const [acknowledgeState, acknowledgeAction] = useActionState(
    (previousState: typeof initialActionState, formData: FormData) =>
      acknowledgeIncidentAction(incidentId, previousState, formData),
    initialActionState
  );
  const [ignoreState, ignoreAction] = useActionState(
    (previousState: typeof initialActionState, formData: FormData) =>
      ignoreIncidentAction(incidentId, previousState, formData),
    initialActionState
  );
  const [commentState, commentAction] = useActionState(
    (previousState: typeof initialActionState, formData: FormData) =>
      addIncidentCommentAction(incidentId, previousState, formData),
    initialActionState
  );

  const canAcknowledge = status === "open" || status === "investigating";
  const canIgnore = ["open", "investigating", "acknowledged", "recovering"].includes(status);

  return (
    <section className="incident-actions" aria-labelledby="incident-actions-heading">
      <div className="detail-section-heading">
        <div>
          <h2 id="incident-actions-heading">Actions</h2>
          <p>Record a team decision or add context to the incident timeline.</p>
        </div>
      </div>
      <div className="incident-actions-grid">
        {canAcknowledge ? (
          <form action={acknowledgeAction} className="incident-action-form">
            <h3>Acknowledge</h3>
            <label>
              <span>Your name</span>
              <input name="actor" required maxLength={120} autoComplete="name" />
            </label>
            <label>
              <span>Note <em>(optional)</em></span>
              <textarea name="comment" maxLength={4000} rows={3} />
            </label>
            <SubmitButton label="Acknowledge incident" />
            {acknowledgeState.error ? <ActionError message={acknowledgeState.error} /> : null}
          </form>
        ) : null}
        {canIgnore ? (
          <form action={ignoreAction} className="incident-action-form">
            <h3>Ignore</h3>
            <label>
              <span>Your name</span>
              <input name="actor" required maxLength={120} autoComplete="name" />
            </label>
            <label>
              <span>Reason</span>
              <textarea name="reason" required maxLength={2000} rows={3} />
            </label>
            <SubmitButton label="Ignore incident" />
            {ignoreState.error ? <ActionError message={ignoreState.error} /> : null}
          </form>
        ) : null}
        <form action={commentAction} className="incident-action-form incident-comment-form">
          <h3>Add comment</h3>
          <label>
            <span>Your name</span>
            <input name="actor" required maxLength={120} autoComplete="name" />
          </label>
          <label>
            <span>Comment</span>
            <textarea name="body" required maxLength={4000} rows={3} />
          </label>
          <SubmitButton label="Add comment" />
          {commentState.error ? <ActionError message={commentState.error} /> : null}
        </form>
      </div>
    </section>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending}>
      {pending ? "Saving..." : label}
    </button>
  );
}

function ActionError({ message }: { message: string }) {
  return <p className="incident-action-error" role="alert">{message}</p>;
}
