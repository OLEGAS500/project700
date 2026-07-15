"use client";

import type { StoreThresholds } from "@eim/core";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { type ThresholdActionState, updateStoreThresholdsAction } from "./actions";

export default function ThresholdsForm({ storeId, thresholds }: { storeId: string; thresholds: StoreThresholds }) {
  const initialState: ThresholdActionState = { error: null };
  const [state, action] = useActionState(
    (previousState: ThresholdActionState, formData: FormData) =>
      updateStoreThresholdsAction(storeId, previousState, formData),
    initialState
  );

  return (
    <form action={action} className="threshold-form">
      <fieldset className="threshold-fieldset">
        <legend>Catalog loss</legend>
        <div className="threshold-field-grid">
          <ThresholdNumberField
            name="catalogDropPercentage"
            label="Catalog drop percentage"
            defaultValue={asPercentage(thresholds.catalogDropPercentage)}
            min="0"
            max="100"
            step="0.1"
            suffix="%"
          />
          <ThresholdNumberField
            name="catalogDropAbsolute"
            label="Catalog drop minimum"
            defaultValue={thresholds.catalogDropAbsolute}
            min="1"
            step="1"
            suffix="products"
          />
        </div>
      </fieldset>

      <fieldset className="threshold-fieldset">
        <legend>Source divergence</legend>
        <div className="threshold-field-grid">
          <ThresholdNumberField
            name="sourceDivergencePercentage"
            label="Divergence percentage"
            defaultValue={asPercentage(thresholds.sourceDivergencePercentage)}
            min="0"
            max="100"
            step="0.1"
            suffix="%"
          />
          <ThresholdNumberField
            name="sourceDivergenceAbsolute"
            label="Divergence minimum"
            defaultValue={thresholds.sourceDivergenceAbsolute}
            min="1"
            step="1"
            suffix="products"
          />
        </div>
      </fieldset>

      <fieldset className="threshold-fieldset">
        <legend>Price and availability</legend>
        <div className="threshold-field-grid">
          <ThresholdNumberField
            name="priceMismatchAbsolute"
            label="Price absolute tolerance"
            defaultValue={thresholds.priceMismatchTolerance.absolute}
            min="0"
            step="0.01"
            suffix="currency units"
          />
          <ThresholdNumberField
            name="priceMismatchRelative"
            label="Price relative tolerance"
            defaultValue={asPercentage(thresholds.priceMismatchTolerance.relative)}
            min="0"
            max="100"
            step="0.01"
            suffix="%"
          />
          <ThresholdNumberField
            name="minimumMismatchCount"
            label="Mismatch minimum"
            defaultValue={thresholds.minimumMismatchCount}
            min="1"
            step="1"
            suffix="products"
          />
          <ThresholdNumberField
            name="minimumMismatchRatio"
            label="Mismatch ratio minimum"
            defaultValue={asPercentage(thresholds.minimumMismatchRatio)}
            min="0"
            max="100"
            step="0.1"
            suffix="%"
          />
        </div>
      </fieldset>

      <fieldset className="threshold-fieldset">
        <legend>SEO and source health</legend>
        <div className="threshold-field-grid">
          <ThresholdNumberField
            name="seoCoverageMinimum"
            label="SEO coverage minimum"
            defaultValue={asPercentage(thresholds.seoCoverageMinimum)}
            min="0"
            max="100"
            step="0.1"
            suffix="%"
          />
          <ThresholdNumberField
            name="sourceHealthConsecutiveFailures"
            label="Source failures before warning"
            defaultValue={thresholds.sourceHealthConsecutiveFailures}
            min="1"
            step="1"
            suffix="checks"
          />
        </div>
      </fieldset>

      <div className="threshold-form-footer">
        <SaveButton />
        {state.error ? <p className="threshold-action-error" role="alert">{state.error}</p> : null}
      </div>
    </form>
  );
}

function ThresholdNumberField({
  name,
  label,
  defaultValue,
  min,
  max,
  step,
  suffix
}: {
  name: string;
  label: string;
  defaultValue: number;
  min: string;
  max?: string;
  step: string;
  suffix: string;
}) {
  return (
    <label className="threshold-field">
      <span>{label}</span>
      <div className="threshold-input-row">
        <input
          type="number"
          name={name}
          defaultValue={defaultValue}
          min={min}
          max={max}
          step={step}
          required
        />
        <em>{suffix}</em>
      </div>
    </label>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? "Saving..." : "Save thresholds"}</button>;
}

function asPercentage(value: number): number {
  return value * 100;
}
