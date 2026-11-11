import React from "react";
import ReactDOM from "react-dom/client";
import Board from "./Board";
import "../../../src/styles.css";
import "./board.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Board />
  </React.StrictMode>,
);
