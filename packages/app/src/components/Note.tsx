import type { HTMLAttributes, ReactNode } from 'react';

/** Visual consequence is independent of announcement urgency and stored verdicts. */
export type NoteTier = 'information' | 'caution' | 'danger';

export function noteClass(tier: NoteTier): string {
  return tier === 'information' ? '' : `message-tier message-${tier}`;
}

export function NoteLabel({ tier }: { tier: NoteTier }) {
  if (tier === 'information') return null;
  return <span className="message-label"><span aria-hidden="true">{tier === 'danger' ? '⛔' : '⚠'} </span>
    {tier === 'danger' ? 'Danger' : 'Caution'}: </span>;
}

/** No implicit live role: callers retain their existing announcement pattern. */
export function Note({ tier, as: Tag = 'div', className = '', children, ...props }: {
  tier: NoteTier; as?: 'div' | 'p'; children: ReactNode;
} & HTMLAttributes<HTMLDivElement>) {
  return <Tag {...props} className={`${className} ${noteClass(tier)}`.trim()}>
    <NoteLabel tier={tier} />{children}
  </Tag>;
}
