import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { Application } from "@nmfs-ocio/radfish";

const root = ReactDOM.createRoot(document.getElementById("root"));

const app = new Application({
  serviceWorker: {
    url: "/service-worker.js",
  },
});

app.on("ready", async () => {
  root.render(
    <React.StrictMode>
      <App application={app} />
    </React.StrictMode>,
  );
});
