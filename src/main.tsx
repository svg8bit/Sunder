import React from "react";
import { createRoot } from "react-dom/client";
import { SolanaProvider } from "@solana/react-hooks";
import { Toaster } from "sonner";
import { App } from "./App";
import { solanaClient } from "./solana/client";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <React.StrictMode>
    <SolanaProvider client={solanaClient}>
      <App />
      <Toaster position="bottom-right" richColors closeButton />
    </SolanaProvider>
  </React.StrictMode>,
);
