const button =
  "rounded-md border border-neutral-700 px-3 py-1 hover:border-neutral-500 focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40";

/** Previous / "Page X of Y" / Next. `page` is 0-based. Renders nothing for a single page. */
export function Pager({
  page,
  pages,
  onPage,
  label,
  className = "",
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
  label: string;
  className?: string;
}) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={label} className={`flex items-center justify-between gap-3 text-sm ${className}`}>
      <button type="button" onClick={() => onPage(page - 1)} disabled={page === 0} className={button}>
        Previous
      </button>
      <span className="text-neutral-400 tabular-nums" aria-live="polite">
        Page {page + 1} of {pages}
      </span>
      <button type="button" onClick={() => onPage(page + 1)} disabled={page >= pages - 1} className={button}>
        Next
      </button>
    </nav>
  );
}
