import type { Metadata } from "next";
import { ModelsTable } from "../components/ModelsTable";

export const metadata: Metadata = { title: "Model Catalog" };

export default function ModelsPage() {
  return (
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-8">
      <h1 className="text-2xl font-bold">Model Catalog</h1>
      <p className="text-sm text-neutral-400">
        Pass the model id as <code className="text-neutral-300">model</code> in your request. Workers online are
        providers that have the model loaded right now; queue depth is requests waiting for one.
      </p>
      <ModelsTable />
    </main>
  );
}
