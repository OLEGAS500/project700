import { z } from "zod";
import {
  incidentSeveritySchema,
  incidentStatusSchema,
  incidentTypeSchema
} from "../schemas";

export const alertTypeSchema = z.enum([
  "incident_opened",
  "incident_worsened",
  "incident_resolved"
]);

export const canonicalAlertPayloadSchema = z
  .object({
    version: z.literal("v1"),
    alertType: alertTypeSchema,
    store: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        domain: z.string()
      })
      .strict(),
    incident: z
      .object({
        id: z.string().uuid(),
        type: incidentTypeSchema,
        severity: incidentSeveritySchema,
        title: z.string(),
        summary: z.string(),
        status: incidentStatusSchema,
        affectedCount: z.number().int().min(0),
        likelySource: z.string().nullable(),
        confidenceScore: z.number().min(0).max(1).nullable(),
        firstDetectedAt: z.string().datetime({ offset: true })
      })
      .strict(),
    metrics: z.array(
      z
        .object({
          name: z.string(),
          beforeValue: z.string().nullable(),
          afterValue: z.string().nullable(),
          unit: z.string().nullable()
        })
        .strict()
    ),
    evidence: z.array(z.string()),
    samples: z
      .array(
        z
          .object({
            stableKey: z.string().optional(),
            offerId: z.string().optional(),
            url: z.string().optional(),
            title: z.string().optional()
          })
          .strict()
      )
      .max(10),
    event: z
      .object({
        id: z.string().uuid(),
        type: z.string(),
        reason: z.string().nullable(),
        occurredAt: z.string().datetime({ offset: true })
      })
      .strict()
  })
  .strict();

export type AlertType = z.infer<typeof alertTypeSchema>;
export type CanonicalAlertPayload = z.infer<typeof canonicalAlertPayloadSchema>;
export type CanonicalAlertMetric = CanonicalAlertPayload["metrics"][number];
export type CanonicalAlertSample = CanonicalAlertPayload["samples"][number];
