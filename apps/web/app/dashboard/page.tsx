"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useRequireMe } from "../components/MeProvider";
import { Pager } from "../components/Pager";
import { card, gateMessage, input, primaryButton } from "../components/ui";
import { api, formatDate, formatNumber } from "../lib/api";

interface Key {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface Entry {
  id: number;
  amount: number;
  kind: string;
  note: string | null;
  createdAt: string;
}

/** One page of a server-paged list (`/ledger`, `/jobs`): `total` rows overall, `pageSize` per page. */
interface Paged {
  total: number;
  pageSize: number;
}

interface Job {
  id: string;
  model: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  source: "api" | "playground";
  promptTokens: number | null;
  completionTokens: number | null;
  credits: number | null;
  createdAt: string;
  servedBy: string | null;
  vote: 1 | -1 | null;
}

const th = "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-400";
const td = "px-3 py-2 text-sm whitespace-nowrap";

/** Loads one page of a paged account list; changing `page` fetches it, `reload` refetches the current page. */
function usePagedList<K extends string, T>(path: string, key: K, ready: boolean) {
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<T[] | null>(null);
  const [total, setTotal] = useState(0);
  const [pageSize, setPageSize] = useState(20);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    const res = await api<Paged & { [P in K]: T[] }>(`${path}?page=${page + 1}`);
    setFailed(!res.ok);
    if (!res.data) return;
    setRows(res.data[key]);
    setTotal(res.data.total);
    setPageSize(res.data.pageSize);
  }, [path, key, page]);

  useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);

  const pages = Math.max(1, Math.ceil(total / pageSize));
  // If rows disappear under the reader (a shorter list), step back to the last page that exists.
  useEffect(() => {
    if (page > pages - 1) setPage(pages - 1);
  }, [page, pages]);

  return { rows, total, page, pages, setPage, reload, failed };
}

export default function Dashboard() {
  const { state } = useRequireMe();
  const ready = state.status === "ready";
  const [balance, setBalance] = useState<number | null>(null);
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ledger = usePagedList<"entries", Entry>("/ledger", "entries", ready);
  const history = usePagedList<"jobs", Job>("/jobs", "jobs", ready);

  const load = useCallback(async () => {
    const [me, k] = await Promise.all([api<{ balance: number }>("/me"), api<{ keys: Key[] }>("/keys")]);
    if (me.data) setBalance(me.data.balance);
    if (k.data) setKeys(k.data.keys);
    setError(me.ok && k.ok ? null : "Could not load some of your data.");
  }, []);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  const gate = gateMessage(state);
  if (gate) return gate;

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      {(error || ledger.failed || history.failed) && (
        <p role="alert" className="text-sm text-red-400">
          {error ?? "Could not load some of your data."}
        </p>
      )}

      <BalanceTile balance={balance} />

      <KeysSection keys={keys} onChange={load} />

      <HistorySection list={history} onVoted={history.reload} />

      <section className={card} aria-labelledby="ledger-title">
        <h2 id="ledger-title" className="mb-3 text-lg font-semibold">
          Ledger
        </h2>
        <div tabIndex={0} role="region" aria-labelledby="ledger-title" className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-neutral-800">
                <th className={th}>When</th>
                <th className={th}>Kind</th>
                <th className={`${th} text-right`}>Amount</th>
                <th className={th}>Note</th>
              </tr>
            </thead>
            <tbody>
              {ledger.rows?.map((e) => (
                <tr key={e.id} className="border-b border-neutral-900">
                  <td className={td}>{formatDate(e.createdAt)}</td>
                  <td className={td}>{e.kind}</td>
                  <td className={`${td} text-right font-mono ${e.amount < 0 ? "text-red-400" : "text-accent"}`}>
                    {e.amount > 0 ? "+" : ""}
                    {formatNumber(e.amount)}
                  </td>
                  <td className={`${td} text-neutral-400`}>{e.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ledger.rows?.length === 0 && <p className="px-3 py-4 text-sm text-neutral-500">No entries yet.</p>}
        </div>
        <Pager page={ledger.page} pages={ledger.pages} onPage={ledger.setPage} label="Ledger pages" className="mt-3" />
      </section>

      <aside
        aria-labelledby="privacy-title"
        className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 text-sm text-neutral-400"
      >
        <h2 id="privacy-title" className="mb-1 text-sm font-semibold text-neutral-200">
          Security note
        </h2>
        <p>
          We do not store private information such as what you send or what the model answers: only metadata like the
          model, token counts, credits and timings. Your prompts are processed in a provider&apos;s browser, though, and
          we cannot guarantee that every provider handles them honestly. Never send passwords, keys or personal data you
          would not want a stranger&apos;s machine to see.{" "}
          <Link href="/docs/privacy" className=" hover:text-white">
            Privacy policy
          </Link>
        </p>
      </aside>
    </main>
  );
}

function BalanceTile({ balance }: { balance: number | null }) {
  // Green is for a healthy balance: below zero the tile goes neutral.
  const negative = balance !== null && balance < 0;
  return (
    <div className="flex flex-wrap gap-3">
      <section
        aria-labelledby="balance-title"
        className={`relative min-w-60 overflow-hidden rounded-xl border bg-gradient-to-br via-neutral-900 to-neutral-950 px-5 py-4 ${
          negative
            ? "border-neutral-700 from-neutral-700/30"
            : "border-accent/30 from-accent/20 shadow-[0_0_28px_-8px_rgba(34,197,94,0.5)]"
        }`}
      >
        <div
          aria-hidden="true"
          className={`absolute -top-8 -right-8 size-28 rounded-full blur-2xl ${negative ? "bg-white/10" : "bg-accent/20"}`}
        />
        <h2
          id="balance-title"
          className="flex items-center gap-2 text-xs font-medium tracking-wide text-neutral-300 uppercase"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke={negative ? "#e5e5e5" : "#22c55e"}
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M13 7l-3.5 6H13l-1 4 4-6h-3.5L13 7Z" strokeLinejoin="round" />
          </svg>
          Credit balance
        </h2>
        <p
          className={`mt-2 text-4xl font-bold tracking-tight tabular-nums ${negative ? "text-neutral-100" : "text-accent"}`}
        >
          {balance === null ? "..." : formatNumber(balance)}
        </p>
      </section>
      <Link
        href="/share"
        className="flex min-w-48 flex-col justify-center rounded-xl border border-neutral-800 bg-neutral-900/60 px-5 py-4 text-sm hover:border-accent/50 focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span className="font-semibold text-neutral-100">Earn more credits</span>
        <span className="text-neutral-400">Share your GPU →</span>
      </Link>
    </div>
  );
}

function HistorySection({
  list,
  onVoted,
}: {
  list: ReturnType<typeof usePagedList<"jobs", Job>>;
  onVoted: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  async function vote(job: Job, value: 1 | -1) {
    const res = await api(`/jobs/${job.id}/vote`, { method: "PUT", body: { value } });
    setError(res.ok ? null : (res.error?.message ?? "Could not save the vote"));
    await onVoted();
  }

  const voteButton = (job: Job, value: 1 | -1) => {
    const active = job.vote === value;
    return (
      <button
        type="button"
        onClick={() => void vote(job, value)}
        aria-pressed={active}
        aria-label={`${value === 1 ? "Thumbs up" : "Thumbs down"} for ${job.servedBy}`}
        className={`min-h-6 min-w-6 rounded border px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-accent ${
          active ? "border-accent text-accent" : "border-neutral-700 hover:border-accent"
        }`}
      >
        {value === 1 ? "👍" : "👎"}
      </button>
    );
  };

  return (
    <section className={card} aria-labelledby="history-title">
      <h2 id="history-title" className="mb-3 text-lg font-semibold">
        Request history
      </h2>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}
      <div tabIndex={0} role="region" aria-labelledby="history-title" className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-800">
              <th className={th}>When</th>
              <th className={th}>Model</th>
              <th className={th}>Status</th>
              <th className={`${th} text-right`}>Tokens in / out</th>
              <th className={`${th} text-right`}>Credits</th>
              <th className={th}>Served by</th>
              <th className={th}>
                <span className="sr-only">Vote</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.rows?.map((j) => (
              <tr key={j.id} className="border-b border-neutral-900">
                <td className={td}>{formatDate(j.createdAt)}</td>
                <td className={td}>
                  {j.model}{" "}
                  <span className="ml-1 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
                    {j.source === "playground" ? "Playground" : "API"}
                  </span>
                </td>
                <td className={`${td} ${j.status === "succeeded" ? "text-accent" : "text-neutral-400"}`}>{j.status}</td>
                <td className={`${td} text-right font-mono`}>
                  {j.promptTokens === null
                    ? "-"
                    : `${formatNumber(j.promptTokens)} / ${formatNumber(j.completionTokens ?? 0)}`}
                </td>
                <td className={`${td} text-right font-mono`}>{j.credits === null ? "-" : formatNumber(j.credits)}</td>
                <td className={td}>{j.servedBy ?? ""}</td>
                <td className={`${td} text-right`}>
                  {j.status === "succeeded" && j.servedBy && (
                    <span className="inline-flex gap-1">
                      {voteButton(j, 1)}
                      {voteButton(j, -1)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.rows?.length === 0 && <p className="px-3 py-4 text-sm text-neutral-500">No requests yet.</p>}
      </div>
      <Pager page={list.page} pages={list.pages} onPage={list.setPage} label="Request history pages" className="mt-3" />
    </section>
  );
}

function KeysSection({ keys, onChange }: { keys: Key[] | null; onChange: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plaintext key exists only here, in memory, until the user dismisses it or reloads.
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api<{ name: string; key: string }>("/keys", { method: "POST", body: { name } });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "Could not create the key");
      return;
    }
    setCreated({ name: res.data.name, key: res.data.key });
    setName("");
    await onChange();
  }

  async function revoke(key: Key) {
    if (!window.confirm(`Revoke "${key.name}" (${key.prefix}...)? Anything using it stops working.`)) return;
    const res = await api(`/keys/${key.id}`, { method: "DELETE" });
    if (!res.ok) setError(res.error?.message ?? "Could not revoke the key");
    else setError(null);
    await onChange();
  }

  return (
    <section className={card} aria-labelledby="keys-title">
      <h2 id="keys-title" className="mb-3 text-lg font-semibold">
        API keys
      </h2>
      <p className="mb-4">
        <Link href="/playground" className={`${primaryButton} inline-block`}>
          Try in Playground
        </Link>
        <span className="ml-3 text-sm text-neutral-400">No key needed: chat with an online model right here.</span>
      </p>

      <form onSubmit={create} className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label htmlFor="key-name" className="mb-1 block text-sm text-neutral-300">
            Key name
          </label>
          <input
            id="key-name"
            name="name"
            required
            maxLength={60}
            autoComplete="off"
            placeholder="e.g. laptop"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={input}
          />
        </div>
        <button type="submit" disabled={busy} className={primaryButton}>
          Create key
        </button>
      </form>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-400">
          {error}
        </p>
      )}

      {created && <NewKey created={created} onDismiss={() => setCreated(null)} />}

      <div tabIndex={0} role="region" aria-labelledby="keys-title" className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-800">
              <th className={th}>Name</th>
              <th className={th}>Key</th>
              <th className={th}>Created</th>
              <th className={th}>Last used</th>
              <th className={th}>Status</th>
              <th className={th}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys?.map((k) => (
              <tr key={k.id} className="border-b border-neutral-900">
                <td className={td}>{k.name}</td>
                <td className={`${td} font-mono text-neutral-300`}>{k.prefix}...</td>
                <td className={td}>{formatDate(k.createdAt)}</td>
                <td className={td}>{k.lastUsedAt ? formatDate(k.lastUsedAt) : "never"}</td>
                <td className={`${td} ${k.revokedAt ? "text-neutral-500" : "text-accent"}`}>
                  {k.revokedAt ? "revoked" : "active"}
                </td>
                <td className={`${td} text-right`}>
                  {!k.revokedAt && (
                    <button
                      type="button"
                      onClick={() => void revoke(k)}
                      aria-label={`Revoke ${k.name}`}
                      className="rounded border border-neutral-700 px-2 py-1 text-xs hover:border-red-500 hover:text-red-400 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {keys?.length === 0 && <p className="px-3 py-4 text-sm text-neutral-500">No keys yet.</p>}
      </div>
    </section>
  );
}

function NewKey({ created, onDismiss }: { created: { name: string; key: string }; onDismiss: () => void }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    clearTimeout(timer.current);
    let text = "Copied";
    try {
      await navigator.clipboard.writeText(created.key);
    } catch {
      // Clipboard access needs a secure context (https or localhost) and permission.
      text = "Copy failed: select the key and copy it by hand";
    }
    setMessage("");
    // Emptied first so a repeated message is announced again.
    requestAnimationFrame(() => setMessage(text));
    timer.current = setTimeout(() => setMessage(""), 3000);
  }

  return (
    <div className="mb-4 rounded-md border border-accent/60 bg-neutral-950 p-4">
      <p className="mb-2 text-sm font-medium text-accent">
        Key &quot;{created.name}&quot; created. Copy it now: it is shown only once.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <code id="new-key" className="min-w-0 flex-1 break-all rounded bg-neutral-900 px-3 py-2 font-mono text-sm">
          {created.key}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label="Copy API key"
          className="min-h-6 min-w-6 rounded-md border border-neutral-700 px-3 py-2 text-sm hover:border-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          Copy
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md px-3 py-2 text-sm text-neutral-400 hover:text-white focus-visible:outline-2 focus-visible:outline-accent"
        >
          Done
        </button>
      </div>
      <span role="status" className="mt-2 block min-h-5 text-sm text-neutral-300">
        {message}
      </span>
    </div>
  );
}
