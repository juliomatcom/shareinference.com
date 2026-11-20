"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type Me } from "../lib/api";

export type MeState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "suspended" }
  | { status: "error" }
  | { status: "ready"; me: Me };

interface MeContext {
  state: MeState;
  setMe(me: Me): void;
  /** True when the session ended and the page is leaving; false when the server did not confirm. */
  signOut(): Promise<boolean>;
}

const Ctx = createContext<MeContext | null>(null);

/** Loads `/api/me` once for the whole app: the header and the gated pages read the same answer. */
export function MeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MeState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    void api<Me>("/me").then((res) => {
      if (!live) return;
      if (res.ok && res.data) setState({ status: "ready", me: res.data });
      else if (res.status === 401) setState({ status: "anonymous" });
      else if (res.status === 403 && res.error?.code === "suspended") setState({ status: "suspended" });
      else setState({ status: "error" });
    });
    return () => {
      live = false;
    };
  }, []);

  const setMe = useCallback((me: Me) => setState({ status: "ready", me }), []);
  const signOut = useCallback(async () => {
    const res = await api("/auth/logout", { method: "POST" });
    // Leave only when the server confirmed: otherwise the session still lives and the user must know.
    if (!res.ok) return false;
    // A full navigation drops every in-memory trace of the account.
    window.location.assign("/");
    return true;
  }, []);

  const value = useMemo(() => ({ state, setMe, signOut }), [state, setMe, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMe(): MeContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useMe outside MeProvider");
  return ctx;
}

/** For gated pages: the state to render; a signed-out visitor gets the sign-in panel (`gateMessage`). */
export function useRequireMe(): MeContext {
  return useMe();
}
