"use server";

import { disconnectMerchantCenter, MerchantCenterStoreNotFoundError } from "@eim/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export type MerchantCenterActionState = { error: string | null };

export async function disconnectMerchantCenterAction(
  storeId: string,
  _previousState: MerchantCenterActionState,
  _formData: FormData
): Promise<MerchantCenterActionState> {
  void _previousState;
  void _formData;

  try {
    await disconnectMerchantCenter(storeId);
  } catch (error) {
    if (error instanceof MerchantCenterStoreNotFoundError) {
      return { error: "This store is no longer available." };
    }
    return { error: "Merchant Center could not be disconnected." };
  }

  revalidatePath(`/stores/${storeId}/merchant-center`);
  revalidatePath("/dashboard");
  redirect(`/stores/${storeId}/merchant-center?oauth=disconnected`);
}
