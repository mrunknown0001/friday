import type { DeploymentPlanDto } from '@friday/shared';
import { Rocket } from 'lucide-react';
import { cn } from '../lib/cn';
import { Badge, type Tone } from './ui/badge';

const ENV_TONE: Record<string, Tone> = {
  development: 'neutral',
  staging: 'warning',
  production: 'danger',
};
const RISK_TONE: Record<string, Tone> = {
  none: 'neutral',
  low: 'neutral',
  medium: 'info',
  high: 'warning',
  critical: 'danger',
};

/** A recorded plan. Recording executes nothing; every command still needs its own approval. */
export function DeploymentPlanCard({ plan }: { plan: DeploymentPlanDto }) {
  return (
    <section
      aria-label={`Deployment plan: ${plan.title}`}
      className={cn(
        'ml-10 space-y-3 rounded-lg border bg-zinc-900/60 p-3 text-sm',
        plan.environment === 'production' ? 'border-red-900/70' : 'border-zinc-800',
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <Rocket className="h-4 w-4 text-zinc-400" aria-hidden />
        <h2 className="font-semibold text-zinc-100">{plan.title}</h2>
        <Badge tone={ENV_TONE[plan.environment]} className="uppercase">
          {plan.environment}
        </Badge>
        <span className="text-xs text-zinc-500">{plan.target}</span>
        <span className="ml-auto text-xs text-zinc-500">Plan only: nothing has run</span>
      </header>
      <p className="text-zinc-300">{plan.summary}</p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-zinc-500">Downtime</dt>
        <dd className="text-zinc-200">{plan.downtimeEstimate}</dd>
        <dt className="text-zinc-500">Data-loss risk</dt>
        <dd className="text-zinc-200">{plan.dataLossRisk}</dd>
        <dt className="text-zinc-500">Rollback</dt>
        <dd className="text-zinc-200">{plan.rollbackPlan || '—'}</dd>
      </dl>

      {plan.preChecks.length > 0 && (
        <div>
          <h3 className="mb-0.5 text-xs font-medium text-zinc-400">Before starting</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-200">
            {plan.preChecks.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-xs font-medium text-zinc-400">Steps</h3>
        <ol className="space-y-1.5">
          {plan.steps.map((step, i) => (
            <li key={i} className="rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-zinc-500">{i + 1}.</span>
                <span className="font-medium text-zinc-100">{step.title}</span>
                <Badge>{step.where}</Badge>
                <Badge tone={RISK_TONE[step.risk]}>{step.risk}</Badge>
                {step.causesDowntime && <Badge tone="warning">downtime</Badge>}
                {!step.reversible && <Badge tone="danger">irreversible</Badge>}
              </div>
              {step.command && (
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-[0.75rem] text-zinc-300">
                  $ {step.command}
                </pre>
              )}
              {step.rollback && <p className="mt-1 text-zinc-400">Rollback: {step.rollback}</p>}
            </li>
          ))}
        </ol>
      </div>

      {plan.verification.length > 0 && (
        <div>
          <h3 className="mb-0.5 text-xs font-medium text-zinc-400">Verification</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-zinc-200">
            {plan.verification.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
