import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon';

const variants: Record<Variant, string> = {
  primary: 'bg-sky-700 text-white hover:bg-sky-600 disabled:bg-sky-900 disabled:text-sky-300/60',
  secondary: 'bg-zinc-800 text-zinc-100 hover:bg-zinc-700 disabled:text-zinc-500',
  ghost: 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-600',
  danger: 'bg-red-700 text-white hover:bg-red-600 disabled:bg-red-950 disabled:text-red-300/60',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  icon: 'h-8 w-8 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center rounded-md font-medium transition-colors disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
