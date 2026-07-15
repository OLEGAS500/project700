import { revalidatePath } from "next/cache";

export function revalidateIncidentViews(
  incidentId: string,
  options: { summariesChanged: boolean }
): void {
  revalidatePath(`/incidents/${incidentId}`);

  if (options.summariesChanged) {
    revalidatePath("/incidents");
    revalidatePath("/dashboard");
  }
}
