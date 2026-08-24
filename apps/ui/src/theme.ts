// Light or dark, remembered. Absent an explicit choice the desk follows the
// OS; the first click on the toggle pins a preference that outlives the tab.
// index.html repeats this resolution inline so the first paint is already the
// right color — the palette itself lives in styles.css under [data-theme].
import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

// Kept in sync by hand with the pre-paint script in index.html.
const THEME_KEY = "pb.theme";

const darkQuery = "(prefers-color-scheme: dark)";

// Storage can be walled off (private modes, embedded webviews). Losing the
// preference is survivable; taking the app down with it is not.
function storedTheme(): Theme | null {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
  return stored === "light" || stored === "dark" ? stored : null;
}

function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* the choice lasts for this tab only */
  }
}

function systemTheme(): Theme {
  return window.matchMedia(darkQuery).matches ? "dark" : "light";
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());
  const [pinned, setPinned] = useState(() => storedTheme() !== null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Nothing pinned yet: keep tracking the OS if it flips mid-session.
  useEffect(() => {
    if (pinned) {
      return;
    }
    const media = window.matchMedia(darkQuery);
    const onChange = () => setTheme(systemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pinned]);

  return [
    theme,
    (next: Theme) => {
      storeTheme(next);
      setPinned(true);
      setTheme(next);
    },
  ];
}
