import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { App } from "./App";
import "./i18n";
import "./index.css";
import "./reduced-motion.css";

// Paint the splash with the default tokens before the core replies. The
// appearance settings replace these attributes after hydration.
const root = document.documentElement.dataset;
root.theme = "dark";
root.preset = "rostalk";
root.accent = "auto";
root.density = "comfortable";
root.radius = "default";
root.fontScale = "100";

const container = document.getElementById("root");
if (!container) {
  throw new Error("index.html is missing #root");
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary name="app" className="h-full">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
