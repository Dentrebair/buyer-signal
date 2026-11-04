"use client";
import { Moon, Sun } from "@phosphor-icons/react";

export function ThemeToggle() {
  const toggle = () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
  };
  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label="Switch light or dark theme">
      <Sun size={16} aria-hidden className="theme-sun" />
      <Moon size={16} aria-hidden className="theme-moon" />
    </button>
  );
}
