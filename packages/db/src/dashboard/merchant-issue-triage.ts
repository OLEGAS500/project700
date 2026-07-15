export type MerchantIssueTriageSourceRow = {
  stableKey: string | null;
  offerId: string | null;
  title: string | null;
  issues: unknown;
};

export type MerchantIssuePriority = "critical" | "high" | "normal";

export type DashboardMerchantIssueSummary = {
  totalProducts: number;
  totalIssues: number;
  truncated: boolean;
  issueGroups: Array<{
    code: string;
    issueCount: number;
    productCount: number;
    priority: MerchantIssuePriority;
    severities: string[];
    attributes: string[];
  }>;
  prioritizedProducts: Array<{
    stableKey: string | null;
    offerId: string | null;
    title: string | null;
    priority: MerchantIssuePriority;
    issueCount: number;
    issueCodes: string[];
    affectedAttributes: string[];
  }>;
};

const maximumIssueTextLength = 256;
const maximumPrioritizedProducts = 50;

type NormalizedIssue = {
  code: string;
  severity: string;
  attribute: string;
};

type IssueGroup = {
  issueCount: number;
  productKeys: Set<string>;
  priority: MerchantIssuePriority;
  severities: Set<string>;
  attributes: Set<string>;
};

export function buildMerchantIssueSummary(
  rows: MerchantIssueTriageSourceRow[],
  truncated = false
): DashboardMerchantIssueSummary {
  const groups = new Map<string, IssueGroup>();
  const products: DashboardMerchantIssueSummary["prioritizedProducts"] = [];

  for (const row of rows) {
    const stableKey = boundedText(row.stableKey);
    const offerId = boundedText(row.offerId);
    const title = boundedText(row.title);
    const productKey = stableKey ?? offerId ?? title;
    if (!productKey) continue;

    const issues = deduplicateIssues(row.issues);
    if (issues.length === 0) continue;

    const issueCodes = new Set<string>();
    const affectedAttributes = new Set<string>();
    let productPriority: MerchantIssuePriority = "normal";

    for (const issue of issues) {
      const priority = priorityForSeverity(issue.severity);
      productPriority = higherPriority(productPriority, priority);
      issueCodes.add(issue.code);
      affectedAttributes.add(issue.attribute);

      const group = groups.get(issue.code) ?? {
        issueCount: 0,
        productKeys: new Set<string>(),
        priority: "normal",
        severities: new Set<string>(),
        attributes: new Set<string>()
      };
      group.issueCount += 1;
      group.productKeys.add(productKey);
      group.priority = higherPriority(group.priority, priority);
      group.severities.add(issue.severity);
      group.attributes.add(issue.attribute);
      groups.set(issue.code, group);
    }

    products.push({
      stableKey,
      offerId,
      title,
      priority: productPriority,
      issueCount: issues.length,
      issueCodes: [...issueCodes].sort(),
      affectedAttributes: [...affectedAttributes].sort()
    });
  }

  const prioritizedProducts = products
    .sort(comparePrioritizedProducts)
    .slice(0, maximumPrioritizedProducts);
  const issueGroups = [...groups.entries()]
    .map(([code, group]) => ({
      code,
      issueCount: group.issueCount,
      productCount: group.productKeys.size,
      priority: group.priority,
      severities: [...group.severities].sort(),
      attributes: [...group.attributes].sort()
    }))
    .sort((left, right) => {
      const priorityDifference = priorityRank(right.priority) - priorityRank(left.priority);
      return priorityDifference || right.issueCount - left.issueCount || left.code.localeCompare(right.code);
    });

  return {
    totalProducts: products.length,
    totalIssues: products.reduce((total, product) => total + product.issueCount, 0),
    truncated,
    issueGroups,
    prioritizedProducts
  };
}

function deduplicateIssues(value: unknown): NormalizedIssue[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const issues: NormalizedIssue[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const code = boundedText(item.code);
    if (!code) continue;
    const severity = boundedText(item.severity)?.toLowerCase() ?? "unknown";
    const attribute = boundedText(item.attribute) ?? "unknown";
    const key = [code, severity, attribute].join("\u001f");
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ code, severity, attribute });
  }
  return issues;
}

function comparePrioritizedProducts(
  left: DashboardMerchantIssueSummary["prioritizedProducts"][number],
  right: DashboardMerchantIssueSummary["prioritizedProducts"][number]
): number {
  const priorityDifference = priorityRank(right.priority) - priorityRank(left.priority);
  if (priorityDifference) return priorityDifference;
  if (right.issueCount !== left.issueCount) return right.issueCount - left.issueCount;
  return (left.stableKey ?? left.offerId ?? left.title ?? "").localeCompare(
    right.stableKey ?? right.offerId ?? right.title ?? ""
  );
}

function priorityForSeverity(severity: string): MerchantIssuePriority {
  if (["critical", "error", "disapproved", "severe"].includes(severity)) return "critical";
  if (severity === "warning") return "high";
  return "normal";
}

function higherPriority(
  left: MerchantIssuePriority,
  right: MerchantIssuePriority
): MerchantIssuePriority {
  return priorityRank(right) > priorityRank(left) ? right : left;
}

function priorityRank(priority: MerchantIssuePriority): number {
  return priority === "critical" ? 3 : priority === "high" ? 2 : 1;
}

function boundedText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximumIssueTextLength)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
