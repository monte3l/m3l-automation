import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";

/** Props accepted by {@link ErrorBoundary}. */
export interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

/**
 * Catches render errors thrown by its descendants and renders a fallback
 * instead of letting the whole console tree unmount.
 *
 * @example
 * ```tsx
 * import { ErrorBoundary } from "@m3l-automation/m3l-console-web/components/ErrorBoundary.js";
 *
 * <ErrorBoundary>
 *   <RiskyWidget />
 * </ErrorBoundary>;
 * ```
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  public override state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("m3l-console-web: render error", error, info);
  }

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div data-testid="error-boundary-fallback">Something went wrong.</div>
      );
    }
    return this.props.children;
  }
}
