import {
  incidentSeveritySchema,
  incidentStatusSchema,
  incidentTypeSchema,
  sourceCheckSourceSchema
} from "@eim/core";
import { z } from "zod";

const dashboardIncidentQuerySchema = z
  .object({
    storeId: z.string().uuid().optional(),
    status: incidentStatusSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    type: incidentTypeSchema.optional(),
    source: sourceCheckSourceSchema.optional(),
    cursor: z.string().min(1).max(1_000).optional(),
    limit: z
      .string()
      .regex(/^\d+$/, "limit must be a positive integer")
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .optional()
  })
  .strict();

export function parseDashboardIncidentQuery(searchParams: URLSearchParams) {
  const entries = [...searchParams.entries()];
  const names = entries.map(([name]) => name);
  if (new Set(names).size !== names.length) {
    return {
      success: false as const,
      error: "Query parameters must not be repeated"
    };
  }

  const parsed = dashboardIncidentQuerySchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) {
    return {
      success: false as const,
      error: "Invalid incident list query",
      issues: parsed.error.flatten()
    };
  }

  return { success: true as const, data: parsed.data };
}
