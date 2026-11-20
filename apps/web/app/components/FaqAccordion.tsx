import { Markdown } from "./Markdown";

interface Props {
  source: string;
  slugs: string[];
}

/** A question heading may contain `code`; render those spans like the rest of the docs. */
function Question({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[0.85em] text-neutral-200">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/**
 * The FAQ document with every `### Question` as a native `<details>`, closed by default. The answers stay in the HTML
 * (search engines read them, no JavaScript needed). Sections without questions, like Limits, render normally, open.
 */
export function FaqAccordion({ source, slugs }: Props) {
  const [head = "", ...sections] = source.split(/^(?=## )/m);
  return (
    <>
      <Markdown source={head} slugs={slugs} />
      {sections.map((section) => {
        const [intro = "", ...questions] = section.split(/^(?=### )/m);
        if (questions.length === 0) return <Markdown key={intro} source={intro} slugs={slugs} />;
        return (
          <section key={intro}>
            <Markdown source={intro} slugs={slugs} />
            <div className="space-y-2">
              {questions.map((q) => {
                const [titleLine = "", ...rest] = q.split("\n");
                const title = titleLine.replace(/^###\s+/, "").trim();
                return (
                  <details
                    key={title}
                    className="group rounded-lg border border-neutral-800 bg-neutral-900/50 open:border-neutral-700"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 hover:bg-neutral-900 focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
                      <h3 className="font-semibold text-neutral-100">
                        <Question text={title} />
                      </h3>
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 20 20"
                        className="size-4 shrink-0 text-neutral-400 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m5 8 5 5 5-5" />
                      </svg>
                    </summary>
                    <div className="px-4 pb-2">
                      <Markdown source={rest.join("\n")} slugs={slugs} />
                    </div>
                  </details>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}
