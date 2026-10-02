"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import AdminTopBar, { AdminSidebar } from "@/components/admin/AdminTopBar";
import SessionGuard from "@/components/admin/SessionGuard";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin = pathname === "/admin/login";
  // Off-canvas nav below lg. Closed on route change (render-time
  // adjustment, not an effect); body scroll locked while open.
  const [navOpen, setNavOpen] = useState(false);
  const [navPathname, setNavPathname] = useState(pathname);
  if (navPathname !== pathname) {
    setNavPathname(pathname);
    setNavOpen(false);
  }

  useEffect(() => {
    if (!navOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [navOpen]);

  if (isLogin) {
    return (
      <>
        <SessionGuard />
        {children}
      </>
    );
  }

  return (
    <div className="min-h-screen flex bg-[var(--ops-bg)]">
      <SessionGuard />
      <AdminSidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="flex-1 min-w-0 flex flex-col">
        <AdminTopBar onOpenNav={() => setNavOpen(true)} />
        <main className="flex-1 min-w-0 overflow-x-hidden texture-cream">{children}</main>
      </div>
    </div>
  );
}
