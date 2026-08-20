import { cloneElement, isValidElement, useId, useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactElement, type ReactNode } from 'react';

export function UiPanel({ className = '', ...props }: HTMLAttributes<HTMLElement>) {
  const { children, ...rest } = props;
  return <section className={`ui-panel ${className}`} {...rest}><span className="ui-panel-corner tl" aria-hidden="true" /><span className="ui-panel-corner br" aria-hidden="true" />{children}</section>;
}

export function Meter({ value, max, segments = 10, label, tone = 'cyan' }: { value: number; max: number; segments?: number; label: string; tone?: 'cyan' | 'red' }) {
  const filled = Math.ceil(Math.max(0, Math.min(1, value / Math.max(1, max))) * segments);
  return <div className={`ui-meter ${tone}`} aria-label={`${label}: ${Math.round(value)} of ${max}`}><span>{label}<b>{String(Math.round(value)).padStart(3, '0')}</b></span><div>{Array.from({ length: segments }, (_, index) => <i className={index < filled ? 'filled' : ''} key={index} />)}</div></div>;
}

export function IconButton({ icon, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string }) {
  return <button className={`icon-button ${className}`} {...props}><span aria-hidden="true">{icon}</span>{children}</button>;
}

/** Toolbar/dialog button with a shared visual language across the game and editor. */
export function UiButton({ tone = 'neutral', className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: 'neutral' | 'primary' | 'danger' | 'ghost' }) {
  return <button className={`ui-button tone-${tone} ${className}`} {...props}>{children}</button>;
}

/**
 * Native `details` keeps the section keyboard-operable and screen-reader
 * announceable without a custom disclosure implementation.
 */
export function Section({ title, meta, defaultOpen = true, className = '', children }: { title: string; meta?: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode }) {
  return (
    <details className={`ui-section ${className}`} open={defaultOpen}>
      <summary><i className="section-caret" aria-hidden="true" /><span>{title}</span>{meta !== undefined && <b>{meta}</b>}</summary>
      <div className="ui-section-body">{children}</div>
    </details>
  );
}

export function Tabs<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (id: T) => void }) {
  return (
    <div className="ui-tabs" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          role="tab"
          type="button"
          aria-selected={option.id === value}
          className={option.id === value ? 'is-active' : ''}
          onClick={() => onChange(option.id)}
        >{option.label}</button>
      ))}
    </div>
  );
}

/**
 * Hover/focus tooltip. The hint is attached to the interactive child through
 * `aria-describedby` so assistive technology announces it on focus, and the
 * bubble stays purely decorative.
 */
export function Tooltip({ hint, children }: { hint: string; children: ReactNode }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const described = isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': id })
    : <span aria-describedby={id}>{children}</span>;
  return (
    <span
      className="ui-tooltip"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {described}
      <span className={`ui-tooltip-bubble ${visible ? 'is-visible' : ''}`} id={id} role="tooltip">{hint}</span>
    </span>
  );
}

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="ui-dialog-scrim" onClick={onClose}>
      <div className="ui-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
        <header><strong>{title}</strong><IconButton icon="×" aria-label="Close dialog" onClick={onClose} /></header>
        <div className="ui-dialog-body">{children}</div>
      </div>
    </div>
  );
}
