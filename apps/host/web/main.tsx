import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KapulaPlayerProvider } from "@kapula/phone";
import { App } from "./App";
import { API_BASE } from "./host-api";
import "./index.css";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <KapulaPlayerProvider config={{ apiBase: API_BASE }}>
        <App />
      </KapulaPlayerProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
