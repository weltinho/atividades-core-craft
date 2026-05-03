import { StrictMode } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import Dashboard from "./Dashboard";
import UtxosPage from "./UtxosPage";
import ZmqFeedPage from "./ZmqFeedPage";

function basename(): string {
  const base = import.meta.env.BASE_URL;
  if (!base || base === "/") return "/";
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export default function App() {
  return (
    <StrictMode>
      <BrowserRouter basename={basename()}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/utxos" element={<UtxosPage />} />
          <Route path="/zmq" element={<ZmqFeedPage />} />
        </Routes>
      </BrowserRouter>
    </StrictMode>
  );
}
