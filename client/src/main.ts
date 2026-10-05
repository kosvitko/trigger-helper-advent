// Точка входа SPA: токены глобально + монтирование Shell.
// Тема: ручное закрепление применяется ДО монтирования — без мигания (051005).
import { mount } from "svelte";
import "./lib/tokens.css";
import App from "./App.svelte";

try {
  const saved = localStorage.getItem("th.theme");
  if (saved === "dark" || saved === "light") {
    document.documentElement.dataset.theme = saved;
  }
} catch {
  /* приватный режим — остаёмся на системной теме */
}

const root = document.getElementById("root");
if (root) {
  mount(App, { target: root });
}
