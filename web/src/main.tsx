import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import App from "./App";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/instrument-serif/400.css";
import "./index.css";
import { connect, getState, refresh, setTheme } from "./store";

setTheme(getState().theme);

// Optional error monitoring: set VITE_SENTRY_DSN at build time.
const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (dsn) {
  import("@sentry/react")
    .then((Sentry) => Sentry.init({ dsn, tracesSampleRate: 0.1 }))
    .catch(() => undefined);
}

void refresh();
connect(api.eventsUrl());
setInterval(() => void refresh(), 15_000);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
