import type { AgentMode } from '@friday/shared';
import {
  Bug,
  Check,
  ChevronDown,
  ClipboardList,
  Code2,
  MessageCircleQuestion,
  Sparkles,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn';

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
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const show = () => {
    setActive(MODES.findIndex((m) => m.id === mode));
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const pick = (m: AgentMode) => {
    if (m !== mode) onChange(m);
    close();
  };

  return (
    <div ref={root} className="relative shrink-0">
      <button
        ref={button}
        type="button"
        aria-label={`Mode: ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${current.label} mode: ${current.description}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            show();
          }
        }}
        className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-300 outline-none hover:bg-zinc-800 focus-visible:ring-1 focus-visible:ring-zinc-600"
      >
        {current.icon}
        {current.label}
        <ChevronDown className="h-3 w-3 text-zinc-500" aria-hidden />
      </button>
      {open && (
        <ul
          ref={list}
          role="listbox"
          aria-label="Mode"
          tabIndex={-1}
          aria-activedescendant={`${id}-${MODES[active]!.id}`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              setActive((a) => (a + step + MODES.length) % MODES.length);
            } else if (e.key === 'Home' || e.key === 'End') {
              e.preventDefault();
              setActive(e.key === 'Home' ? 0 : MODES.length - 1);
            } else if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              pick(MODES[active]!.id);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              close();
            } else if (e.key === 'Tab') {
              setOpen(false);
            }
          }}
          className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl outline-none"
        >
          {MODES.map((m, i) => (
            <li
              key={m.id}
              id={`${id}-${m.id}`}
              role="option"
              aria-selected={m.id === mode}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(m.id)}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-md px-3 py-2',
                i === active && 'bg-zinc-800',
              )}
            >
              <span className="mt-0.5 text-zinc-400">{m.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-zinc-100">{m.label}</span>
                <span className="block text-xs leading-snug text-zinc-400">{m.description}</span>
              </span>
              {m.id === mode && <Check className="mt-0.5 h-3.5 w-3.5 text-sky-400" aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
