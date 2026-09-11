import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./styles.css";

// Care UI switches on a CLASS, not `prefers-color-scheme`, because it ships five modes — light,
// dark, high-contrast, protanopia, tritanopia — and a media query expresses only two. The system
// preference is the default; the class is the seam a theme picker would drive.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = (dark: boolean): void => {
  document.documentElement.classList.toggle("dark", dark);
};
applyTheme(media.matches);
media.addEventListener("change", (e) => applyTheme(e.matches));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401/404 is an answer, not a hiccup. One retry covers a service restart without making a
      // real outage feel slow.
      retry: (failureCount, error) =>
        failureCount < 1 && (error as { status?: number }).status === 0,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
