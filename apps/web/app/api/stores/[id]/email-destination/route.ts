import { emailDestinationInputSchema } from "@eim/core";
import {
  disableEmailDestination,
  getEmailDestination,
  getStore,
  upsertEmailDestination
} from "@eim/db";
import { NextResponse } from "next/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!(await getStore(id))) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }
  return NextResponse.json({ destination: await getEmailDestination(id) });
}

export async function PUT(request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!(await getStore(id))) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }
  const parsed = emailDestinationInputSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid email destination payload", issues: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const destination = await upsertEmailDestination(id, parsed.data);
  return NextResponse.json({ destination });
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  if (!(await getStore(id))) {
    return NextResponse.json({ error: "Store not found" }, { status: 404 });
  }
  const destination = await disableEmailDestination(id);
  return NextResponse.json({ destination });
}
