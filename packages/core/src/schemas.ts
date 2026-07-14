import { z } from "zod";

export const baselineStatusSchema = z.enum([
  "learning",
  "pending_user_confirmation",
  "active"
]);

export const snapshotStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "partial",
  "failed"
]);

export const baselineRoleSchema = z.enum([
  "candidate",
  "confirmed_baseline",
  "normal_check",
  "confirmation_check"
]);

export const sourceCheckStatusSchema = z.enum([
  "success",
  "partial",
  "timeout",
  "blocked",
  "authentication_failed",
  "parse_failed",
  "source_unavailable"
]);

export const sourceCheckSourceSchema = z.enum([
  "category",
  "product_page",
  "sitemap",
  "feed",
  "merchant_center"
]);

export const sourceItemSourceSchema = z.enum([
  "storefront",
  "sitemap",
  "feed",
  "merchant_center"
]);

export const incidentSeveritySchema = z.enum(["critical", "warning", "info"]);

export const incidentStatusSchema = z.enum([
  "open",
  "investigating",
  "acknowledged",
  "recovering",
  "resolved",
  "ignored"
]);

export const incidentTypeSchema = z.enum([
  "catalog_drop",
  "source_divergence",
  "seo_regression",
  "price_availability_mismatch",
  "source_health"
]);

const incidentActorSchema = z.string().trim().min(1).max(120);

export const acknowledgeIncidentInputSchema = z.object({
  actor: incidentActorSchema,
  comment: z.string().trim().min(1).max(4_000).optional()
});

export const ignoreIncidentInputSchema = z.object({
  actor: incidentActorSchema,
  reason: z.string().trim().min(1).max(2_000)
});

export const addIncidentCommentInputSchema = z.object({
  actor: incidentActorSchema,
  body: z.string().trim().min(1).max(4_000)
});

export const storeThresholdsSchema = z
  .object({
    catalogDropPercentage: z.number().min(0).max(1),
    catalogDropAbsolute: z.number().int().min(1),
    sourceDivergencePercentage: z.number().min(0).max(1),
    sourceDivergenceAbsolute: z.number().int().min(1),
    priceMismatchTolerance: z
      .object({
        absolute: z.number().min(0),
        relative: z.number().min(0)
      })
      .strict(),
    minimumMismatchCount: z.number().int().min(1),
    minimumMismatchRatio: z.number().min(0).max(1),
    seoCoverageMinimum: z.number().min(0).max(1),
    sourceHealthConsecutiveFailures: z.number().int().min(1)
  })
  .strict();

export const updateStoreThresholdsInputSchema = storeThresholdsSchema.partial().strict();

export const alertPreferencesSchema = z
  .object({
    enabled: z.boolean(),
    emailEnabled: z.boolean(),
    telegramEnabled: z.boolean(),
    mutedIncidentTypes: z.array(incidentTypeSchema).max(5),
    notifyOnOpen: z.boolean(),
    notifyOnWorsening: z.boolean(),
    notifyOnRecovery: z.boolean(),
    worseningAffectedCountPercent: z.number().min(0).max(1),
    worseningSeverityIncrease: z.boolean()
  })
  .strict();

export const updateAlertPreferencesInputSchema = alertPreferencesSchema.partial().strict();

export const telegramDestinationInputSchema = z
  .object({
    chatId: z.string().trim().min(1).max(128),
    threadId: z.number().int().positive().nullable(),
    displayName: z.string().trim().min(1).max(120).nullable(),
    enabled: z.boolean()
  })
  .strict();

const maintenanceWindowDateSchema = z.string().datetime({ offset: true });

export const createMaintenanceWindowInputSchema = z
  .object({
    startsAt: maintenanceWindowDateSchema,
    endsAt: maintenanceWindowDateSchema,
    reason: z.string().trim().min(1).max(2_000),
    createdBy: incidentActorSchema
  })
  .superRefine((value, context) => {
    if (new Date(value.endsAt) <= new Date(value.startsAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endsAt"],
        message: "endsAt must be after startsAt"
      });
    }
  });

const absoluteUrlSchema = z
  .string()
  .trim()
  .url()
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "URL must use http or https"
  });

export const createStoreInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain: absoluteUrlSchema,
  sitemapUrl: absoluteUrlSchema,
  feedUrl: absoluteUrlSchema,
  categoryUrls: z.array(absoluteUrlSchema).min(1).max(20)
});

export const storeSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  domain: z.string().url(),
  sitemapUrl: z.string().url(),
  feedUrl: z.string().url(),
  merchantCenterAccountId: z.string().nullable(),
  baselineStatus: baselineStatusSchema,
  baselineConfirmedAt: z.string().nullable(),
  createdAt: z.string()
});

export const monitoredCategorySchema = z.object({
  id: z.string().uuid(),
  storeId: z.string().uuid(),
  url: z.string().url(),
  name: z.string().nullable(),
  criticality: z.number().int().min(1).max(5)
});

export const createSnapshotInputSchema = z.object({
  storeId: z.string().uuid(),
  baselineRole: baselineRoleSchema
});

export const queuedSnapshotSchema = z.object({
  id: z.string().uuid(),
  storeId: z.string().uuid(),
  status: snapshotStatusSchema,
  baselineRole: baselineRoleSchema,
  createdAt: z.string()
});

export const sourceItemInputSchema = z.object({
  source: sourceItemSourceSchema,
  stableKey: z.string().optional(),
  offerId: z.string().optional(),
  url: z.string().url().optional(),
  title: z.string().optional(),
  price: z.string().optional(),
  currency: z.string().optional(),
  availability: z.string().optional(),
  imageUrl: z.string().url().optional(),
  httpStatus: z.number().int().optional(),
  indexability: z.enum(["indexable", "noindex", "blocked_by_robots", "unknown"]).optional(),
  canonicalUrl: z.string().url().optional(),
  schemaPresent: z.boolean().optional(),
  merchantStatus: z.enum(["approved", "pending", "disapproved", "unknown"]).optional(),
  merchantIssues: z.array(z.record(z.string(), z.unknown())).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  rawHash: z.string()
});

export const sourceCheckResultSchema = z.object({
  source: sourceCheckSourceSchema,
  url: z.string().url().optional(),
  status: sourceCheckStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int().min(0),
  httpStatus: z.number().int().optional(),
  itemsObserved: z.number().int().min(0),
  totalItemsSeen: z.number().int().min(0).optional(),
  skippedItems: z.number().int().min(0).optional(),
  items: z.array(sourceItemInputSchema),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  errorSamples: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export type BaselineStatus = z.infer<typeof baselineStatusSchema>;
export type SnapshotStatus = z.infer<typeof snapshotStatusSchema>;
export type BaselineRole = z.infer<typeof baselineRoleSchema>;
export type SourceCheckStatus = z.infer<typeof sourceCheckStatusSchema>;
export type SourceCheckSource = z.infer<typeof sourceCheckSourceSchema>;
export type SourceItemSource = z.infer<typeof sourceItemSourceSchema>;
export type IncidentSeverity = z.infer<typeof incidentSeveritySchema>;
export type IncidentStatus = z.infer<typeof incidentStatusSchema>;
export type IncidentType = z.infer<typeof incidentTypeSchema>;
export type AcknowledgeIncidentInput = z.infer<typeof acknowledgeIncidentInputSchema>;
export type IgnoreIncidentInput = z.infer<typeof ignoreIncidentInputSchema>;
export type AddIncidentCommentInput = z.infer<typeof addIncidentCommentInputSchema>;
export type StoreThresholds = z.infer<typeof storeThresholdsSchema>;
export type UpdateStoreThresholdsInput = z.infer<typeof updateStoreThresholdsInputSchema>;
export type AlertPreferences = z.infer<typeof alertPreferencesSchema>;
export type UpdateAlertPreferencesInput = z.infer<typeof updateAlertPreferencesInputSchema>;
export type TelegramDestinationInput = z.infer<typeof telegramDestinationInputSchema>;
export type CreateMaintenanceWindowInput = z.infer<typeof createMaintenanceWindowInputSchema>;

export const defaultStoreThresholds: StoreThresholds = {
  catalogDropPercentage: 0.2,
  catalogDropAbsolute: 20,
  sourceDivergencePercentage: 0.1,
  sourceDivergenceAbsolute: 20,
  priceMismatchTolerance: {
    absolute: 0.02,
    relative: 0.001
  },
  minimumMismatchCount: 5,
  minimumMismatchRatio: 0.2,
  seoCoverageMinimum: 0.8,
  sourceHealthConsecutiveFailures: 2
};

export const defaultAlertPreferences: AlertPreferences = {
  enabled: true,
  emailEnabled: true,
  telegramEnabled: false,
  mutedIncidentTypes: [],
  notifyOnOpen: true,
  notifyOnWorsening: true,
  notifyOnRecovery: false,
  worseningAffectedCountPercent: 0.2,
  worseningSeverityIncrease: true
};
export type CreateStoreInput = z.infer<typeof createStoreInputSchema>;
export type Store = z.infer<typeof storeSchema>;
export type MonitoredCategory = z.infer<typeof monitoredCategorySchema>;
export type CreateSnapshotInput = z.infer<typeof createSnapshotInputSchema>;
export type QueuedSnapshot = z.infer<typeof queuedSnapshotSchema>;
export type SourceItemInput = z.infer<typeof sourceItemInputSchema>;
export type SourceCheckResult = z.infer<typeof sourceCheckResultSchema>;
