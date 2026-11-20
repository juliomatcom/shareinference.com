import Link from "next/link";
import { GithubIcon } from "./GithubIcon";
import { card, primaryButton } from "./ui";

/** The agreement line shown wherever sign-in starts. */
export function SignInNote() {
  return (
    <p className="text-xs text-neutral-400">
      By signing in you agree to the{" "}
      <Link href="/docs/terms" className="text-accent">
        Terms
      </Link>{" "}
      and{" "}
      <Link href="/docs/privacy" className="text-accent">
        Privacy policy
      </Link>
      .
    </p>
  );
}

/** Sign-in entry (the `/signin` page and gated pages for signed-out visitors): the GitHub button next to the note. */
export function SignInPanel() {
  return (
    <main className="mx-auto max-w-md px-4 py-12">
      <section className={`${card} space-y-4`} aria-labelledby="signin-heading">
        <h1 id="signin-heading" className="text-xl font-bold">
          Sign in
        </h1>
        <p className="text-sm text-neutral-400">ShareInference uses your GitHub account to sign you in.</p>
        <a href="/api/auth/github" className={`${primaryButton} flex items-center justify-center gap-2 py-2.5`}>
          <GithubIcon className="h-5 w-5" />
          Sign in with GitHub
        </a>
        <SignInNote />
      </section>
    </main>
  );
}
