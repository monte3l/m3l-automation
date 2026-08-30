import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { M3LConsoleWebError } from "./errors/console-web-error.js";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new M3LConsoleWebError(
    "ERR_CONSOLE_WEB_ROOT_MISSING",
    "m3l-console-web: #root element not found",
  );
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
