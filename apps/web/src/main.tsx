import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Fragment, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RefusedError } from "./api";
import { AuthProvider } from "./auth";
import "./index.css";
import { replayParam } from "./replay";

// A refusal is the server's answer, not a glitch: show it at once instead of retrying.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, err) => !(err instanceof RefusedError) && count < 2 },
  },
});

// A saved replay is public and static: don't even load the sign-in provider for it.
const Auth = replayParam(window.location.search) === null ? AuthProvider : Fragment;

// biome-ignore lint/style/noNonNullAssertion: root element is in index.html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Auth>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </Auth>
  </StrictMode>,
);
