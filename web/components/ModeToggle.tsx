"use client"
import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Sun, Moon } from "lucide-react"

/** One icon button in the header: shows the current theme and switches between dark and light. */
export default function ModeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  // The theme is only known in the browser; render a neutral button until then to avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), [])
  const isLight = mounted && resolvedTheme === "light"
  const label = !mounted ? "Toggle light or dark theme" : isLight ? "Switch to dark theme" : "Switch to light theme"
  return (
    <button
      type="button"
      onClick={() => setTheme(isLight ? "dark" : "light")}
      aria-label={label}
      title={label}
      className="flex items-center justify-center w-8 h-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      {isLight ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  )
}
