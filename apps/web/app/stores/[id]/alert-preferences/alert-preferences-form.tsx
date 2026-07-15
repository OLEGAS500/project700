"use client";

import { incidentTypeSchema, type AlertPreferences, type IncidentType } from "@eim/core";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  type AlertPreferencesActionState,
  updateAlertPreferencesAction
} from "./actions";
import { decimalToPercentage } from "./percentage";

const alertPreferenceIncidentTypes = incidentTypeSchema.options;

const incidentTypeLabels: Record<IncidentType, string> = {
  catalog_drop: "Catalog drop",
  source_divergence: "Source divergence",
  seo_regression: "SEO regression",
  price_availability_mismatch: "Price and availability mismatch",
  source_health: "Source health"
};

export default function AlertPreferencesForm({
  storeId,
  record
}: {
  storeId: string;
  record: { preferences: AlertPreferences };
}) {
  const initialState: AlertPreferencesActionState = { error: null };
  const [state, action] = useActionState(
    (previousState: AlertPreferencesActionState, formData: FormData) =>
      updateAlertPreferencesAction(storeId, previousState, formData),
    initialState
  );
  const { preferences } = record;

  return (
    <form action={action} className="alert-preferences-form">
      <fieldset className="alert-preferences-fieldset">
        <legend>Delivery</legend>
        <div className="alert-preferences-option-grid">
          <PreferenceToggle
            name="enabled"
            label="Alerts enabled"
            description="Create channel delivery decisions for this store."
            defaultChecked={preferences.enabled}
          />
          <PreferenceToggle
            name="emailEnabled"
            label="Email channel"
            description="Allow eligible alerts to create email deliveries."
            defaultChecked={preferences.emailEnabled}
          />
          <PreferenceToggle
            name="telegramEnabled"
            label="Telegram channel"
            description="Allow eligible alerts to create Telegram deliveries."
            defaultChecked={preferences.telegramEnabled}
          />
        </div>
      </fieldset>

      <fieldset className="alert-preferences-fieldset">
        <legend>Incident lifecycle</legend>
        <div className="alert-preferences-option-grid">
          <PreferenceToggle
            name="notifyOnOpen"
            label="New incidents"
            description="Notify when a confirmed incident opens."
            defaultChecked={preferences.notifyOnOpen}
          />
          <PreferenceToggle
            name="notifyOnWorsening"
            label="Worsening incidents"
            description="Notify when an incident worsens or reopens during recovery."
            defaultChecked={preferences.notifyOnWorsening}
          />
          <PreferenceToggle
            name="notifyOnRecovery"
            label="Recovered incidents"
            description="Notify after an incident is fully resolved."
            defaultChecked={preferences.notifyOnRecovery}
          />
          <PreferenceToggle
            name="worseningSeverityIncrease"
            label="Severity increase"
            description="Treat a severity increase as a worsening signal."
            defaultChecked={preferences.worseningSeverityIncrease}
          />
          <label className="alert-preferences-number-field">
            <span>Worsening affected-product threshold</span>
            <div>
              <input
                type="number"
                name="worseningAffectedCountPercent"
                defaultValue={decimalToPercentage(preferences.worseningAffectedCountPercent)}
                min="0"
                max="100"
                step="any"
                required
              />
              <em>% of affected products</em>
            </div>
          </label>
        </div>
      </fieldset>

      <fieldset className="alert-preferences-fieldset">
        <legend>Muted incident types</legend>
        <p className="alert-preferences-fieldset-copy">
          Muted types remain visible in the incident timeline but do not create channel deliveries.
        </p>
        <div className="alert-preferences-mute-grid">
          {alertPreferenceIncidentTypes.map((incidentType) => (
            <PreferenceToggle
              key={incidentType}
              name="mutedIncidentTypes"
              value={incidentType}
              label={incidentTypeLabels[incidentType]}
              description={mutedDescription(incidentType)}
              defaultChecked={preferences.mutedIncidentTypes.includes(incidentType)}
            />
          ))}
        </div>
      </fieldset>

      <div className="alert-preferences-form-footer">
        <SaveButton />
        {state.error ? <p className="alert-preferences-action-error" role="alert">{state.error}</p> : null}
      </div>
    </form>
  );
}

function PreferenceToggle({
  name,
  value,
  label,
  description,
  defaultChecked
}: {
  name: string;
  value?: string;
  label: string;
  description: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="alert-preferences-toggle">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} />
      <span>
        <strong>{label}</strong>
        <em>{description}</em>
      </span>
    </label>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? "Saving..." : "Save preferences"}</button>;
}

function mutedDescription(incidentType: IncidentType): string {
  if (incidentType === "source_health") return "Transport or parsing problems from a monitored source.";
  if (incidentType === "catalog_drop") return "A confirmed group of products missing from monitored sources.";
  if (incidentType === "source_divergence") return "A material gap between comparable monitored sources.";
  if (incidentType === "seo_regression") return "A grouped regression in indexability or page signals.";
  return "A grouped price or availability mismatch across high-confidence matches.";
}
