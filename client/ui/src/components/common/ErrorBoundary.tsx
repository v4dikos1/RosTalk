import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/common/ErrorState";
import { Button } from "@/components/ui/button";
import { reportUiError } from "@/lib/errors";

export interface ErrorBoundaryProps {
  /** Stable name for the diagnostics log, e.g. "streams". */
  name: string;
  children: ReactNode;
  className?: string | undefined;
}

interface ErrorBoundaryState {
  failed: boolean;
  /** Bumped on retry so the subtree mounts from scratch. */
  resetKey: number;
}

/**
 * Keeps one crashed panel from taking the whole window down.
 *
 * React unmounts the entire root when a render throws without a boundary; that
 * is how a 150 % stream volume used to blank the interface. The fallback is a
 * compact panel with a button that remounts the subtree.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false, resetKey: 0 };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportUiError(this.props.name, error, info.componentStack);
  }

  private readonly reload = () => {
    this.setState((state) => ({
      failed: false,
      resetKey: state.resetKey + 1,
    }));
  };

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <ErrorBoundaryFallback
          {...(this.props.className ? { className: this.props.className } : {})}
          onReload={this.reload}
        />
      );
    }
    // The key remounts the children after a retry: their own state may be the
    // reason the first render threw.
    return (
      <Fragment key={this.state.resetKey}>{this.props.children}</Fragment>
    );
  }
}

function ErrorBoundaryFallback({
  className,
  onReload,
}: {
  className?: string | undefined;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ErrorState
      {...(className ? { className } : {})}
      title={t("errors.panel.title")}
      description={t("errors.panel.hint")}
      action={
        <Button size="sm" variant="secondary" onClick={onReload}>
          {t("errors.panel.reload")}
        </Button>
      }
    />
  );
}
