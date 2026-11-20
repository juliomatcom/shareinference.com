import type { Metadata } from "next";
import Link from "next/link";
import { card } from "../components/ui";
import { allDocs } from "./lib";

export const metadata: Metadata = { title: "Docs" };

export default function DocsIndex() {
  const docs = allDocs();
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <h1 className="text-2xl font-bold">Docs</h1>
      <ul className="space-y-3">
        {docs.map((d) => (
          <li key={d.slug}>
            <Link href={`/docs/${d.slug}`} className={`${card} block hover:border-accent/60`}>
              <span className="font-semibold">{d.title}</span>
              <span className="ml-2 text-sm text-neutral-500">/docs/{d.slug}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
