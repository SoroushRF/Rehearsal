import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RefusedError } from "./api";
import { AuthProvider } from "./auth";
import "./index.css";

// A refusal is the server's answer, not a glitch: show it at once instead of retrying.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, err) => !(err instanceof RefusedError) && count < 2 },
  },
});

// biome-ignore lint/style/noNonNullAssertion: root element is in index.html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AuthProvider>
  </StrictMode>,
);
