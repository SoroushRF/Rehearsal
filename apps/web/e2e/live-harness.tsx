import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { LivePlans } from "../src/components/LivePlans";
import "../src/index.css";

/** Renders the live review flow with plain fetch; Playwright answers every /api call. */
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

// biome-ignore lint/style/noNonNullAssertion: root element is in live.html
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <main className="mx-auto max-w-4xl p-6 font-sans text-slate-900">
      <LivePlans apiFetch={(path, init) => fetch(path, init)} />
    </main>
  </QueryClientProvider>,
);
