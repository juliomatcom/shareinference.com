"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { REPO_URL } from "../lib/api";
import { GithubIcon } from "./GithubIcon";
import { useMe } from "./MeProvider";
import { useSharing, type Run } from "./SharingProvider";

const link =
  "rounded px-2 py-1 text-sm text-neutral-300 hover:text-white focus-visible:outline-2 focus-visible:outline-accent";
const howItWorks = { href: "/how-it-works", label: "How It Works" };
const models = { href: "/models", label: "Model Catalog" };
const leaderboard = { href: "/leaderboard", label: "Leaderboard" };
const docs = { href: "/docs", label: "Docs" };
const playground = { href: "/playground", label: "Playground" };
const dashboard = { href: "/dashboard", label: "Dashboard" };
const settings = { href: "/settings", label: "Settings" };

// What sits in the top bar (from `lg`) depends on the visitor; everything else lives in the menu.
const publicBar = [howItWorks, models, leaderboard, docs];
const signedInBar = [dashboard, leaderboard, playground, models];
const signedInMenu = [howItWorks, docs, settings];

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 text-base font-semibold tracking-tight text-white">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#22c55e" strokeWidth="1.8">
        <rect x="6" y="6" width="12" height="12" rx="2" />
        <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
        <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
      </svg>
      ShareInference
    </Link>
  );
}

/** Short status for the header while sharing (the full wording lives on /share and in the bottom bar). */
const SHORT_STATUS: Record<Run, string> = {
  idle: "",
  loading: "Loading",
  connecting: "Connecting",
  ready: "Ready",
  busy: "Busy",
  reconnecting: "Reconnecting",
  stopped: "",
};

const menuItem =
  "block rounded-md px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-900 hover:text-white focus-visible:outline-2 focus-visible:outline-accent";

export function Header() {
  const { state, signOut } = useMe();
  const { active, run } = useSharing();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);
  // The header lives in the layout, so it must close its own menu on navigation.
  useEffect(() => setOpen(false), [pathname]);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  // Escape closes the menu and hands focus back to its button; a click or tap outside closes it too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menuButton.current?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      if (!menuBox.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const signedIn = state.status === "ready";
  const barLinks = signedIn ? signedInBar : publicBar;
  const menuLinks = signedIn ? signedInMenu : [];
  const signInButton = (
    <Link
      href="/signin"
      className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1 text-sm font-medium hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
    >
      <GithubIcon />
      Sign In
    </Link>
  );

  return (
    <header className="sticky top-0 z-40 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center gap-x-4 px-4 py-3">
        <Logo />
        {/* Core pages only; everything else lives in the menu at the top right. */}
        <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
          {barLinks.map((l) => (
            <Link key={l.href} href={l.href} className={link}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          {active ? (
            <Link
              href="/share"
              aria-label={`Sharing your GPU: ${SHORT_STATUS[run]}`}
              className="hidden items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-1 text-sm font-semibold text-accent hover:bg-accent/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:inline-flex"
            >
              <span className="relative flex size-2.5 items-center justify-center" aria-hidden="true">
                <span className="absolute size-2.5 rounded-full bg-accent opacity-60 motion-safe:animate-ping" />
                <span className="relative size-2 rounded-full bg-accent" />
              </span>
              {SHORT_STATUS[run]}
            </Link>
          ) : (
            <Link
              href="/share"
              className="hidden rounded-md bg-accent px-3 py-1 text-sm font-semibold text-neutral-950 hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent lg:inline-block"
            >
              Share GPU
            </Link>
          )}
          {state.status === "anonymous" && <span className="hidden sm:inline-flex">{signInButton}</span>}
          <div ref={menuBox} className="relative">
            <button
              ref={menuButton}
              type="button"
              aria-label="Menu"
              aria-expanded={open}
              aria-controls="header-menu"
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-2 rounded-md border border-neutral-700 p-1.5 hover:border-neutral-500 focus-visible:outline-2 focus-visible:outline-accent"
            >
              {signedIn && state.me.avatarUrl && (
                <img src={state.me.avatarUrl} alt="" width={22} height={22} className="rounded-full" />
              )}
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
            {open && (
              <div
                id="header-menu"
                className="absolute top-full right-0 mt-2 w-64 rounded-lg border border-neutral-800 bg-neutral-950 p-2 shadow-xl shadow-black/60"
              >
                {signedIn && (
                  <div className="flex items-center gap-3 border-b border-neutral-800 px-3 pt-1 pb-3">
                    {state.me.avatarUrl && (
                      <img src={state.me.avatarUrl} alt="" width={32} height={32} className="rounded-full" />
                    )}
                    <span className="min-w-0 truncate text-sm font-medium text-neutral-100">
                      {state.me.displayName}
                    </span>
                  </div>
                )}
                <nav aria-label="Menu" className="flex flex-col gap-0.5 pt-1">
                  {/* Below lg the bar has no room for its links or Share GPU, so they move in here. */}
                  <div className="flex flex-col gap-0.5 lg:hidden">
                    {barLinks.map((l) => (
                      <Link key={l.href} href={l.href} className={menuItem}>
                        {l.label}
                      </Link>
                    ))}
                    <Link href="/share" className={`${menuItem} font-semibold text-accent`}>
                      {active ? `Sharing: ${SHORT_STATUS[run]}` : "Share GPU"}
                    </Link>
                    {menuLinks.length > 0 && <hr className="my-1 border-neutral-800" />}
                  </div>
                  {menuLinks.length > 0 && (
                    <>
                      {menuLinks.map((l) => (
                        <Link key={l.href} href={l.href} className={menuItem}>
                          {l.label}
                        </Link>
                      ))}
                    </>
                  )}
                  <hr className="my-1 border-neutral-800" />
                  <a href={REPO_URL} rel="noopener noreferrer" className={`${menuItem} flex items-center gap-2`}>
                    <GithubIcon className="h-4 w-4" />
                    View Repository
                  </a>
                  {state.status === "anonymous" && (
                    <Link href="/signin" className={`${menuItem} sm:hidden`}>
                      Sign In
                    </Link>
                  )}
                  {signedIn && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        void signOut().then((ok) => setSignOutFailed(!ok));
                      }}
                      className={`${menuItem} w-full text-left`}
                    >
                      Sign out
                    </button>
                  )}
                </nav>
              </div>
            )}
          </div>
        </div>
      </div>
      {signOutFailed && (
        <p role="alert" className="mx-auto max-w-5xl px-4 pb-2 text-sm text-red-400">
          Could not sign out. Try again.
        </p>
      )}
    </header>
  );
}
