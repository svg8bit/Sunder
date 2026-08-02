import * as Dialog from "@radix-ui/react-dialog";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check, X } from "lucide-react";
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: "primary" | "secondary" | "ghost" | "danger"; readonly size?: "sm" | "md" | "lg" }>(
  function Button({ className, variant = "secondary", size = "md", type = "button", ...props }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn("button", `button--${variant}`, `button--${size}`, className)}
        {...props}
      />
    );
  },
);

export function Panel({ children, className, title, action }: { readonly children: ReactNode; readonly className?: string; readonly title?: ReactNode; readonly action?: ReactNode }) {
  return (
    <section className={cn("panel", className)}>
      {title || action ? (
        <header className="panel__header">
          <div className="panel__title">{title}</div>
          {action}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Field({ label, hint, valid, error, children, className }: { readonly label: string; readonly hint?: ReactNode; readonly valid?: boolean; readonly error?: string; readonly children: ReactNode; readonly className?: string }) {
  return (
    <label className={cn("field", className)}>
      <span className="field__label">{label}</span>
      <span className="field__control">
        {children}
        {valid ? <Check aria-label="Valid" className="field__valid" size={17} /> : null}
      </span>
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn("input", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn("input textarea", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={cn("input select", className)} {...props} />;
});

export function Badge({ children, tone = "neutral", className }: { readonly children: ReactNode; readonly tone?: "neutral" | "good" | "warn" | "bad" | "accent"; readonly className?: string }) {
  return <span className={cn("badge", `badge--${tone}`, className)}>{children}</span>;
}

export function Toggle({ checked, onCheckedChange, label, description, disabled }: { readonly checked: boolean; readonly onCheckedChange: (value: boolean) => void; readonly label: ReactNode; readonly description?: ReactNode; readonly disabled?: boolean }) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <div className={cn("toggle-row", disabled && "is-disabled")}>
      <div>
        <div className="toggle-row__label" id={labelId}>{label}</div>
        {description ? <div className="toggle-row__description" id={descriptionId}>{description}</div> : null}
      </div>
      <SwitchPrimitive.Root className="switch" checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-labelledby={labelId} aria-describedby={description ? descriptionId : undefined}>
        <SwitchPrimitive.Thumb className="switch__thumb" />
      </SwitchPrimitive.Root>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { readonly value: T; readonly options: readonly { readonly value: T; readonly label: string; readonly disabled?: boolean }[]; readonly onChange: (value: T) => void; readonly ariaLabel: string }) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button key={option.value} type="button" disabled={option.disabled} aria-pressed={option.value === value} className={cn("segmented__item", option.value === value && "is-active")} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onOpenChange, title, description, children, trigger, className }: { readonly open?: boolean; readonly onOpenChange?: (open: boolean) => void; readonly title: string; readonly description?: string; readonly children: ReactNode; readonly trigger?: ReactNode; readonly className?: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="modal__overlay" />
        <Dialog.Content className={cn("modal", className)}>
          <div className="modal__heading">
            <div>
              <Dialog.Title className="modal__title">{title}</Dialog.Title>
              {description ? <Dialog.Description className="modal__description">{description}</Dialog.Description> : null}
            </div>
            <Dialog.Close asChild>
              <button type="button" className="icon-button" aria-label="Close dialog"><X size={18} /></button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function EmptyState({ icon, title, description, action }: { readonly icon: ReactNode; readonly title: string; readonly description: string; readonly action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <div className="empty-state__title">{title}</div>
      <div className="empty-state__description">{description}</div>
      {action}
    </div>
  );
}

export function Metric({ label, value, detail, tone }: { readonly label: string; readonly value: ReactNode; readonly detail?: ReactNode; readonly tone?: "good" | "warn" }) {
  return (
    <div className={cn("metric", tone && `metric--${tone}`)}>
      <span className="metric__label">{label}</span>
      <strong className="metric__value">{value}</strong>
      {detail ? <span className="metric__detail">{detail}</span> : null}
    </div>
  );
}
