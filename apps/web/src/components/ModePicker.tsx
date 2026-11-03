import type { AgentMode } from '@friday/shared';
import { Bug, ClipboardList, Code2, MessageCircleQuestion, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';

export const MODES: Array<{ id: AgentMode; label: string; icon: ReactNode; description: string }> =
  [
    {
      id: 'auto',
      label: 'Auto',
      icon: <Sparkles className="h-3.5 w-3.5" aria-hidden />,
      description: 'Friday chooses how to work (it may suggest another mode)',
    },
    {
      id: 'code',
      label: 'Code',
      icon: <Code2 className="h-3.5 w-3.5" aria-hidden />,
      description: 'Implement changes and verify them',
    },
    {
      id: 'plan',
      label: 'Plan',
      icon: <ClipboardList className="h-3.5 w-3.5" aria-hidden />,
      description: 'Investigate and write a plan; changes nothing until you accept it',
    },
    {
      id: 'debug',
      label: 'Debug',
      icon: <Bug className="h-3.5 w-3.5" aria-hidden />,
      description: 'Reproduce the problem, find the cause, fix it and prove it',
    },
    {
      id: 'ask',
      label: 'Ask',
      icon: <MessageCircleQuestion className="h-3.5 w-3.5" aria-hidden />,
      description: 'Answers and explanations only; reads, never changes anything',
    },
  ];

export const modeInfo = (mode: AgentMode) => MODES.find((m) => m.id === mode)!;

/** The conversation's mode, next to the message box. A change applies from the next message. */
export function ModePicker({
  mode,
  onChange,
}: {
  mode: AgentMode;
  onChange: (mode: AgentMode) => void;
}) {
  const current = modeInfo(mode);
  return (
    <label
      className="flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-zinc-300 hover:bg-zinc-800 focus-within:ring-1 focus-within:ring-zinc-600"
      title={`${current.label} mode: ${current.description}`}
    >
      {current.icon}
      <select
        aria-label="Mode"
        value={mode}
        onChange={(e) => onChange(e.target.value as AgentMode)}
        className="cursor-pointer appearance-none bg-transparent pr-1 outline-none"
      >
        {MODES.map((m) => (
          <option key={m.id} value={m.id} title={m.description} className="bg-zinc-900">
            {m.label}
          </option>
        ))}
      </select>
    </label>
  );
}
