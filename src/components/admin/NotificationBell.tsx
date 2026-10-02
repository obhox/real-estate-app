"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

type Notification = {
  id: string;
  message: string;
  read: boolean;
  createdAt: string;
  bookingId: string | null;
  booking: { ref: string } | null;
};

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/notifications");
    if (!res.ok) return;
    const data = await res.json();
    setNotifications(data.notifications);
    setUnreadCount(data.unreadCount);
    setLoaded(true);
  }, []);

  useEffect(() => {
    // react-hooks/set-state-in-effect flags this, but it's the standard
    // "fetch on mount" pattern load()'s setState calls only run after its
    // internal `fetch` resolves (a later microtask), not synchronously
    // within this effect body, so there's no render-cascade risk here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  async function markAllRead() {
    setUnreadCount(0);
    setNotifications([]);
    await fetch("/api/admin/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    });
  }

  async function markRead(id: string) {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
    setUnreadCount((c) => Math.max(0, c - 1));
    await fetch("/api/admin/notifications", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
  }

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!loaded) load();
        }}
        className="relative text-sm text-white/80 hover:text-white flex items-center gap-1.5"
        aria-label="Notifications"
      >
        <span className="h-7 w-7 rounded-full bg-white/10 grid place-items-center text-xs">◉</span>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-[var(--gold-600)] text-white text-[10px] rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 bg-white border border-[var(--line)] rounded-xl shadow-lg z-20 max-h-96 overflow-y-auto">
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--line)]">
              <span className="text-xs font-medium text-[var(--ink-muted)]">Notifications</span>
              {unreadCount > 0 && (
                <button onClick={markAllRead} className="text-xs text-[var(--ink-muted)] hover:underline">
                  Mark all read
                </button>
              )}
            </div>
            {notifications.length === 0 && (
              <p className="px-4 py-6 text-center text-xs text-stone-400">No notifications yet.</p>
            )}
            {notifications.map((n) => (
              <Link
                key={n.id}
                href={n.bookingId ? `/admin/bookings/${n.bookingId}` : "/admin/bookings"}
                onClick={() => {
                  markRead(n.id);
                  setOpen(false);
                }}
                className="block px-4 py-3 text-sm border-b border-stone-50 last:border-0 hover:bg-stone-50 text-stone-800 bg-stone-50/50"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
                  <div className="font-medium">
                    {n.message}
                    <div className="text-xs text-stone-400 font-normal mt-0.5">
                      {new Date(n.createdAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
