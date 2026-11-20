"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useMe } from "../components/MeProvider";
import { SignInPanel } from "../components/SignIn";

export default function SignIn() {
  const { state } = useMe();
  const router = useRouter();
  const signedIn = state.status === "ready";
  useEffect(() => {
    if (signedIn) router.replace("/dashboard");
  }, [signedIn, router]);
  return <SignInPanel />;
}
