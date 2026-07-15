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
  productsTruncated: boolean;
  issuesTruncated: boolean;
  groupsTruncated: boolean;
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
const maximumProducts = 500;
const maximumIssuesPerProduct = 100;
const maximumNormalizedIssues = maximumProducts * maximumIssuesPerProduct;
const maximumIssueGroups = 100;
const maximumGroupSeverities = 8;
const maximumGroupAttributes = 16;
const maximumProductIssueCodes = 16;
const maximumProductAttributes = 16;
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
  productsTruncated = false
): DashboardMerchantIssueSummary {
  const groups = new Map<string, IssueGroup>();
  const products: DashboardMerchantIssueSummary["prioritizedProducts"] = [];
  let issuesTruncated = false;
  let groupsTruncated = false;
  let normalizedIssuesProcessed = 0;

  for (const row of rows.slice(0, maximumProducts)) {
    const stableKey = boundedText(row.stableKey);
    const offerId = boundedText(row.offerId);
    const title = boundedText(row.title);
    const productKey = stableKey ?? offerId ?? title;
    if (!productKey) continue;

    const normalized = deduplicateIssues(row.issues);
    const issues = normalized.issues.slice(0, maximumNormalizedIssues - normalizedIssuesProcessed);
    issuesTruncated ||= normalized.truncated || issues.length < normalized.issues.length;
    normalizedIssuesProcessed += issues.length;
    if (issues.length === 0) continue;

    const issueCodes = new Set<string>();
    const affectedAttributes = new Set<string>();
    let productPriority: MerchantIssuePriority = "normal";

    for (const issue of issues) {
      const priority = priorityForSeverity(issue.severity);
      productPriority = higherPriority(productPriority, priority);
      if (issueCodes.size < maximumProductIssueCodes) issueCodes.add(issue.code);
      else issuesTruncated = true;
      if (affectedAttributes.size < maximumProductAttributes) affectedAttributes.add(issue.attribute);
      else issuesTruncated = true;

      let group = groups.get(issue.code);
      if (!group) {
        if (groups.size >= maximumIssueGroups) {
          groupsTruncated = true;
          continue;
        }
        group = {
          issueCount: 0,
          productKeys: new Set<string>(),
          priority: "normal",
          severities: new Set<string>(),
          attributes: new Set<string>()
        };
        groups.set(issue.code, group);
      }
      group.issueCount += 1;
      group.productKeys.add(productKey);
      group.priority = higherPriority(group.priority, priority);
      if (group.severities.size < maximumGroupSeverities) group.severities.add(issue.severity);
      else groupsTruncated = true;
      if (group.attributes.size < maximumGroupAttributes) group.attributes.add(issue.attribute);
      else groupsTruncated = true;
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
    truncated: productsTruncated || rows.length > maximumProducts || issuesTruncated || groupsTruncated,
    productsTruncated: productsTruncated || rows.length > maximumProducts,
    issuesTruncated,
    groupsTruncated,
    issueGroups,
    prioritizedProducts
  };
}

function deduplicateIssues(value: unknown): { issues: NormalizedIssue[]; truncated: boolean } {
  if (!Array.isArray(value)) return { issues: [], truncated: false };

  const seen = new Set<string>();
  const issues: NormalizedIssue[] = [];
  for (const item of value.slice(0, maximumIssuesPerProduct)) {
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
  return { issues, truncated: value.length > maximumIssuesPerProduct };
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
