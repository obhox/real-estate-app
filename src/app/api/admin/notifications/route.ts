import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { getInboxBookingIds } from "@/lib/inbox";

export async function GET() {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve notifications whose booking no longer has an inbox item (work done).
  const openIds = await getInboxBookingIds();
  const stale = await prisma.notification.findMany({
    where: { userId: session!.user.id, resolvedAt: null, bookingId: { not: null } },
    select: { id: true, bookingId: true },
  });
  const doneIds = stale.filter((n) => n.bookingId && !openIds.has(n.bookingId)).map((n) => n.id);
  if (doneIds.length > 0) {
    await prisma.notification.updateMany({
      where: { id: { in: doneIds } },
      data: { resolvedAt: new Date() },
    });
  }

  // Bell shows open + unread only: viewing (read) or finishing the work
  // (resolved) clears the row from the list. Resolution of stale rows above
  // keeps "action taken" clearing even items never opened.
  const [notifications, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session!.user.id, read: false, resolvedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { booking: { select: { ref: true } } },
    }),
    prisma.notification.count({ where: { userId: session!.user.id, read: false, resolvedAt: null } }),
  ]);

  return NextResponse.json({ notifications, unreadCount });
}

export async function PATCH(request: NextRequest) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  if (body?.all === true) {
    await prisma.notification.updateMany({
      where: { userId: session!.user.id, read: false },
      data: { read: true },
    });
    return NextResponse.json({ ok: true });
  }

  if (typeof body?.id === "string") {
    // userId in the where clause keeps this scoped to the caller's own
    // notifications an admin can't mark someone else's as read.
    await prisma.notification.updateMany({
      where: { id: body.id, userId: session!.user.id },
      data: { read: true },
    });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Provide { id } or { all: true }" }, { status: 400 });
}
