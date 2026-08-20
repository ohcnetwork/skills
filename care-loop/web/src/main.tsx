import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router";
import "./styles.css";

// Care UI switches themes on a CLASS (`.dark`), not on `prefers-color-scheme`, because it ships five
// modes — light, dark, high-contrast, protanopia, tritanopia — and only two of those a media query
// can express. Following the system preference is the default; the class is the seam a theme picker
// would drive later without any CSS changing.
const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyTheme = (dark: boolean): void => {
  document.documentElement.classList.toggle("dark", dark);
};
applyTheme(media.matches);
media.addEventListener("change", (e) => applyTheme(e.matches));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401/404 is an answer, not a hiccup. Retrying only makes sense for the transport failing,
      // and one retry is enough to cover a service restart without making a real outage feel slow.
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
