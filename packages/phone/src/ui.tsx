import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * The few primitives the player screens need, styled with the kp-* tokens
 * (kapula.css) so the controller carries its own look into any host. They
 * started as copies of the monorepo's shared kit and keep its props; the kit
 * itself is never imported here.
 */

type ButtonVariant = "primary" | "secondary" | "success" | "danger" | "ghost";
type ButtonSize = "small" | "medium" | "large";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
};

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-kp-accent-primary hover:bg-kp-accent-primary-hover text-kp-accent-on-primary",
  secondary:
    "bg-kp-bg-tertiary hover:bg-kp-bg-hover text-kp-text-primary border border-kp-border",
  success: "bg-kp-accent-success hover:brightness-110 text-kp-accent-on-primary",
  danger: "bg-kp-accent-danger hover:brightness-110 text-kp-accent-on-primary",
  ghost: "bg-transparent hover:bg-kp-bg-tertiary text-kp-text-secondary",
};

const BUTTON_SIZE: Record<ButtonSize, string> = {
  small: "px-3 py-1.5 text-sm",
  medium: "px-4 py-2 text-base",
  large: "px-6 py-3 text-lg",
};

export const Button = ({
  children,
  variant = "primary",
  size = "medium",
  fullWidth = false,
  loading = false,
  disabled = false,
  className = "",
  ...props
}: ButtonProps) => (
  <button
    className={`font-semibold rounded-kp transition-all duration-200 active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed ${BUTTON_VARIANT[variant]} ${BUTTON_SIZE[size]} ${fullWidth ? "w-full" : "w-auto"} ${className}`}
    disabled={disabled || loading}
    {...props}
  >
    {loading ? <Spinner className="h-5 w-5" /> : children}
  </button>
);

type CardProps = {
  children: ReactNode;
  className?: string;
  padding?: "none" | "small" | "medium" | "large";
};

const CARD_PADDING: Record<NonNullable<CardProps["padding"]>, string> = {
  none: "",
  small: "p-3 sm:p-4",
  medium: "p-4 sm:p-6",
  large: "p-6 sm:p-8",
};

export const Card = ({ children, className = "", padding = "medium" }: CardProps) => (
  <div
    className={`bg-kp-bg-secondary border border-kp-border-light rounded-kp-lg shadow-kp-card ${CARD_PADDING[padding]} ${className}`}
  >
    {children}
  </div>
);

type BadgeVariant = "success" | "warning" | "danger" | "neutral";

const BADGE_VARIANT: Record<BadgeVariant, string> = {
  success: "bg-kp-accent-success/15 text-kp-accent-success",
  warning: "bg-kp-accent-warning/15 text-kp-accent-warning",
  danger: "bg-kp-accent-danger/15 text-kp-accent-danger-light",
  neutral: "bg-kp-text-muted/15 text-kp-text-muted",
};

export const Badge = ({
  children,
  variant = "neutral",
  className = "",
}: {
  children: ReactNode;
  variant?: BadgeVariant;
  className?: string;
}) => (
  <span
    className={`inline-block rounded-full font-bold px-2 py-1 text-xs ${BADGE_VARIANT[variant]} ${className}`}
  >
    {children}
  </span>
);

export const LoadingState = ({ message = "Loading…" }: { message?: string }) => (
  <div className="flex items-center justify-center min-h-screen">
    <div className="flex flex-col items-center gap-4">
      <Spinner className="h-12 w-12 text-kp-accent-primary" />
      <div className="text-kp-text-primary text-lg">{message}</div>
    </div>
  </div>
);

const Spinner = ({ className }: { className: string }) => (
  <svg
    className={`animate-spin ${className}`}
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
  >
    <circle
      className="opacity-25"
      cx="12"
      cy="12"
      r="10"
      stroke="currentColor"
      strokeWidth="4"
    />
    <path
      className="opacity-75"
      fill="currentColor"
      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
    />
  </svg>
);
