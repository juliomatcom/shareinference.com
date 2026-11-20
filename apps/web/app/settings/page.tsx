"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRequireMe } from "../components/MeProvider";
import { card, gateMessage, input, primaryButton } from "../components/ui";
import { api, type Me } from "../lib/api";

export default function Settings() {
  const { state, setMe } = useRequireMe();
  const me = state.status === "ready" ? state.me : null;
  const [displayName, setDisplayName] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Fill the form once, when the profile first arrives.
  const loaded = me !== null;
  useEffect(() => {
    if (me) {
      setDisplayName(me.displayName);
      setDeviceLabel(me.deviceLabel ?? "");
    }
  }, [loaded]);

  const gate = gateMessage(state);
  if (gate) return gate;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const res = await api<Me>("/me", { method: "PATCH", body: { displayName, deviceLabel } });
    setBusy(false);
    if (!res.ok || !res.data) {
      setError(res.error?.message ?? "Could not save");
      return;
    }
    setMe(res.data);
    setDisplayName(res.data.displayName);
    setDeviceLabel(res.data.deviceLabel ?? "");
    setSaved(true);
  }

  return (
    <main className="mx-auto max-w-xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-bold">Settings</h1>
      <form onSubmit={save} className={`${card} space-y-5`}>
        <div>
          <label htmlFor="display-name" className="block text-sm font-medium">
            Display name
          </label>
          <span id="display-name-hint" className="mb-1 block text-xs text-neutral-400">
            Public name on the leaderboard. 3-32 characters: letters, digits, _ and -.
          </span>
          <input
            id="display-name"
            name="displayName"
            required
            minLength={3}
            maxLength={32}
            pattern="[A-Za-z0-9_\-]{3,32}"
            autoComplete="off"
            aria-describedby="display-name-hint"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={input}
          />
        </div>
        <div>
          <label htmlFor="device-label" className="block text-sm font-medium">
            Device label
          </label>
          <span id="device-label-hint" className="mb-1 block text-xs text-neutral-400">
            Optional, shown next to your GPU. Up to 40 characters.
          </span>
          <input
            id="device-label"
            name="deviceLabel"
            maxLength={40}
            autoComplete="off"
            aria-describedby="device-label-hint"
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value)}
            className={input}
          />
        </div>
        <div className="flex items-center gap-4">
          <button type="submit" disabled={busy} className={primaryButton}>
            Save
          </button>
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          <p role="status" className="text-sm text-accent">
            {saved ? "Saved" : ""}
          </p>
        </div>
      </form>
      {me && (
        <p className="text-sm text-neutral-500">
          Signed in with GitHub as <span className="text-neutral-300">{me.githubLogin}</span>.
        </p>
      )}
    </main>
  );
}
