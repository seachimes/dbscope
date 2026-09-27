import type { PlanStep } from "#shared/types.ts";
import { compact, n } from "../lib/format.ts";
import { usePreferences } from "../lib/preferences.tsx";
import { localizedStep } from "../lib/localize.ts";

/**
 * The signature view: an EXPLAIN plan drawn as a signal chain.
 *
 * The connector between two steps is as wide as the number of rows flowing
 * through it (log-scaled, since row counts span six orders of magnitude). A
 * query that reads 256,180 rows to return 20 is a funnel you can see before
 * you read a single number — which is the whole point of the tool.
 */
function pipeWidth(rows: number | undefined): number {
  if (!rows || rows <= 1) return 3;
  // log10(1) -> 3px, log10(1e6) -> ~58px.
  return Math.max(3, Math.min(58, Math.log10(rows) * 9.2));
}

export function PlanFlow({ steps }: { steps: PlanStep[] }) {
  const { locale, t } = usePreferences();
  let carried: number | undefined;

  return (
    <div className="flow">
      {steps.map((rawStep, i) => {
        const step = localizedStep(rawStep, locale);
        if (step.rows !== undefined) carried = step.rows;
        const next = steps[i + 1];
        const width = pipeWidth(carried);

        return (
          <div key={step.id} style={{ width: "100%", display: "contents" }}>
            <div className={`flow-step flow-step-${step.severity}`}>
              <div className="flow-step-head">
                <span className="flow-label">{step.label}</span>
                {step.table ? <span className="flow-table">{step.table}</span> : null}
                {step.rows !== undefined ? (
                  <span className="flow-rows">
                    {n(step.rows)} {t("rows")}
                  </span>
                ) : null}
              </div>
              {step.sublabel ? <div className="flow-sub">{step.sublabel}</div> : null}
              {step.notes.length > 0 ? (
                <ul className="flow-notes">
                  {step.notes.map((note, j) => (
                    <li key={j}>{note}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            {next ? (
              <div className="flow-connector">
                <div className="flow-pipe" style={{ width }} />
                {carried !== undefined ? (
                  <span className="flow-flowlabel">
                    {compact(carried)} {t("rows")}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
